#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    CallToolRequest,
    Tool as McpToolType, // Alias the MCP Tool type to avoid naming conflict
    McpError,
    ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import * as dotenv from "dotenv";
import path from "path";
import { getValidCredentials, setupTokenRefresh, loadCredentialsQuietly } from './auth.js';
// Define base types for our tool system
export interface InternalToolResponse {
    content: {
        type: string;
        text: string;
    }[];
    isError: boolean;
}

export interface Tool<T, C = any> {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: Record<string, unknown>;
        required: readonly string[];
    };
    handler: (args: T, client: C) => Promise<InternalToolResponse>;
}

// Input types for each tool
export interface GDriveSearchInput {
    query: string;
    pageToken?: string;
    pageSize?: number;
}

export interface GDriveReadFileInput {
    fileId: string;
}

export interface GSheetsUpdateCellInput {
    fileId: string;
    range: string;
    value: string;
}

export interface GSheetsReadInput {
    spreadsheetId: string;
    ranges?: string[]; // Optional A1 notation ranges like "Sheet1!A1:B10"
    sheetId?: number; // Optional specific sheet ID
}

// Load environment variables from .env file
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Debug: Check if env vars are loaded
console.error('Debug - Environment variables:', {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ? 'Set' : 'Not set',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ? 'Set' : 'Not set',
  GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN ? 'Set' : 'Not set'
});

interface GoogleDriveClient {
    drive: ReturnType<typeof google.drive>;
    sheets: ReturnType<typeof google.sheets>;
}

// --- Tool: gdrive_search.js ---
export const gdriveSearchSchema = {
    name: "gdrive_search",
    description: "Search for files in Google Drive",
    inputSchema: {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "Name of the file to be searched for",
            },
            pageToken: {
                type: "string",
                description: "Token for the next page of results",
                optional: true,
            },
            pageSize: {
                type: "number",
                description: "Number of results per page (max 100)",
                optional: true,
            },
        },
        required: ["query"],
    },
} as const;

export async function gdriveSearchHandler(
    args: GDriveSearchInput,
    client: GoogleDriveClient
): Promise<InternalToolResponse> {
    const { drive } = client;
    const userQuery = args.query.trim();
    let searchQuery = "";

    // If query is empty, list all files
    if (!userQuery) {
        searchQuery = "trashed = false";
    } else {
        // Escape special characters in the query
        const escapedQuery = userQuery.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

        // Build search query with multiple conditions
        const conditions = [];

        // Search in title
        conditions.push(`name contains '${escapedQuery}'`);

        // If specific file type is mentioned in query, add mimeType condition
        if (userQuery.toLowerCase().includes("sheet")) {
            conditions.push("mimeType = 'application/vnd.google-sheets.spreadsheet'");
        }

        searchQuery = `(${conditions.join(" or ")}) and trashed = false`;
    }

    try {
        const res = await drive.files.list({
            q: searchQuery,
            pageSize: args.pageSize || 10,
            pageToken: args.pageToken,
            orderBy: "modifiedTime desc",
            fields: "nextPageToken, files(id, name, mimeType, modifiedTime, size)",
        });

        let response = `Found ${res.data.files?.length ?? 0} files:\n`;
        const fileList = (res.data.files || [])
            .map((file) => `Name: ${file.name}\nID: ${file.id}`)
            .join("\n---\n");
        response += fileList;

        // Add pagination info if there are more results
        if (res.data.nextPageToken) {
            response += `\n\nMore results available. Use pageToken: ${res.data.nextPageToken}`;
        }

        return {
            content: [
                {
                    type: "text",
                    text: response,
                },
            ],
            isError: false,
        };
    } catch (error: any) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error searching Google Drive: ${error.message}`,
                },
            ],
            isError: true,
        };
    }
}

// --- Tool: gdrive_read_file.js ---
export const gdriveReadFileSchema = {
    name: "gdrive_read_file",
    description: "Read contents of a file from Google Drive",
    inputSchema: {
        type: "object",
        properties: {
            fileId: {
                type: "string",
                description: "ID of the file to read",
            },
        },
        required: ["fileId"],
    },
} as const;

async function readGoogleDriveFile(
    fileId: string,
    drive: ReturnType<typeof google.drive>
): Promise<{ name: string; contents: { mimeType: string; text?: string; blob?: string } }> {
    // First get file metadata to check mime type
    const file = await drive.files.get({
        fileId,
        fields: "mimeType,name",
    });

    // For Google Docs/Sheets/etc we need to export
    if (file.data.mimeType?.startsWith("application/vnd.google-apps")) {
        let exportMimeType: string;
        switch (file.data.mimeType) {
            case "application/vnd.google-apps.document":
                exportMimeType = "text/markdown";
                break;
            case "application/vnd.google-apps.spreadsheet":
                exportMimeType = "text/csv";
                break;
            case "application/vnd.google-apps.presentation":
                exportMimeType = "text/plain";
                break;
            case "application/vnd.google-apps.drawing":
                exportMimeType = "image/png";
                break;
            default:
                exportMimeType = "text/plain";
        }

        const res = await drive.files.export(
            { fileId, mimeType: exportMimeType },
            { responseType: "text" }
        );

        return {
            name: file.data.name || fileId,
            contents: {
                mimeType: exportMimeType,
                text: res.data as string,
            },
        };
    }

    // For regular files download content
    const res = await drive.files.get(
        { fileId, alt: "media" },
        { responseType: "arraybuffer" }
    );
    const mimeType = file.data.mimeType || "application/octet-stream";
    const isText =
        mimeType.startsWith("text/") || mimeType === "application/json";
    const content = Buffer.from(res.data as ArrayBuffer);

    return {
        name: file.data.name || fileId,
        contents: {
            mimeType,
            ...(isText
                ? { text: content.toString("utf-8") }
                : { blob: content.toString("base64") }),
        },
    };
}

export async function gdriveReadFileHandler(
    args: GDriveReadFileInput,
    client: GoogleDriveClient
): Promise<InternalToolResponse> {
    const { drive } = client;
    try {
        const result = await readGoogleDriveFile(args.fileId, drive);
        return {
            content: [
                {
                    type: "text",
                    text: `Contents of <span class="math-inline">\{result\.name\}\:\\n\\n</span>{result.contents.text || result.contents.blob}`,
                },
            ],
            isError: false,
        };
    } catch (error: any) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error reading Google Drive file: ${error.message}`,
                },
            ],
            isError: true,
        };
    }
}

// --- Tool: gsheets_update_cell.js ---
export const gsheetsUpdateCellSchema = {
    name: "gsheets_update_cell",
    description: "Update a cell value in a Google Spreadsheet",
    inputSchema: {
        type: "object",
        properties: {
            fileId: {
                type: "string",
                description: "ID of the spreadsheet",
            },
            range: {
                type: "string",
                description: "Cell range in A1 notation (e.g. 'Sheet1!A1')",
            },
            value: {
                type: "string",
                description: "New cell value",
            },
        },
        required: ["fileId", "range", "value"],
    },
} as const;

export async function gsheetsUpdateCellHandler(
    args: GSheetsUpdateCellInput,
    client: GoogleDriveClient
): Promise<InternalToolResponse> {
    const { sheets } = client;
    const { fileId, range, value } = args;

    try {
        await sheets.spreadsheets.values.update({
            spreadsheetId: fileId,
            range: range,
            valueInputOption: "RAW",
            requestBody: {
                values: [[value]],
            },
        });

        return {
            content: [
                {
                    type: "text",
                    text: `Updated cell ${range} to value: ${value}`,
                },
            ],
            isError: false,
        };
    } catch (error: any) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error updating Google Sheet cell: ${error.message}`,
                },
            ],
            isError: true,
        };
    }
}

// --- Tool: gsheets_read.js ---
export const gsheetsReadSchema = {
    name: "gsheets_read",
    description:
        "Read data from a Google Spreadsheet with flexible options for ranges and formatting",
    inputSchema: {
        type: "object",
        properties: {
            spreadsheetId: {
                type: "string",
                description: "The ID of the spreadsheet to read",
            },
            ranges: {
                type: "array",
                items: {
                    type: "string",
                },
                description:
                    "Optional array of A1 notation ranges like ['Sheet1!A1:B10']. If not provided, reads entire sheet.",
            },
            sheetId: {
                type: "number",
                description:
                    "Optional specific sheet ID to read. If not provided with ranges, reads first sheet.",
            },
        },
        required: ["spreadsheetId"],
    },
} as const;

interface CellData {
    value: any;
    location: string;
}

interface ProcessedSheetData {
    sheetName: string;
    data: CellData[][];
    totalRows?: number;
    totalColumns?: number;
    columnHeaders?: CellData[];
}

function getA1Notation(row: number, col: number): string {
    let a1 = "";

    while (col > 0) {
        col--;
        a1 = String.fromCharCode(65 + (col % 26)) + a1;
        col = Math.floor(col / 26);
    }

    return `<span class="math-inline">\{a1\}</span>{row + 1}`;
}

async function processSheetData(response: any): Promise<ProcessedSheetData[]> {
    const results: ProcessedSheetData[] = [];

    // Handle both single and multiple ranges
    const valueRanges = response.data.valueRanges || [response.data];

    for (const range of valueRanges) {
        const values = range.values || [];
        if (values.length === 0) continue;

        // Extract sheet name from range
        const rangeParts = range.range?.split("!") || [];
        const sheetName = rangeParts[0]?.replace(/'/g, "") || "Sheet1";

        // Process data with cell locations
        const processedValues = values.map((row: any[], rowIndex: number) =>
            row.map((cell: any, colIndex: number) => ({
                value: cell,
                location: `<span class="math-inline">\{sheetName\}\!</span>{getA1Notation(rowIndex, colIndex + 1)}`,
            }))
        );

        // Process headers with locations
        const columnHeaders = processedValues[0];
        const data = processedValues.slice(1);

        results.push({
            sheetName,
            data,
            totalRows: values.length,
            totalColumns: columnHeaders.length,
            columnHeaders,
        });
    }

    return results;
}

export async function gsheetsReadHandler(
    args: GSheetsReadInput,
    client: GoogleDriveClient
): Promise<InternalToolResponse> {
    const { sheets } = client;
    try {
        let response;

        if (args.ranges) {
            // Read specific ranges
            response = await sheets.spreadsheets.values.batchGet({
                spreadsheetId: args.spreadsheetId,
                ranges: args.ranges,
            });
        } else if (args.sheetId !== undefined) {
            // Get sheet name from sheet ID first
            const metadata = await sheets.spreadsheets.get({
                spreadsheetId: args.spreadsheetId,
                fields: "sheets.properties",
            });

            const sheet = metadata.data.sheets?.find(
                (s) => s.properties?.sheetId === args.sheetId
            );

            if (!sheet?.properties?.title) {
                throw new Error(`Sheet ID ${args.sheetId} not found`);
            }

            response = await sheets.spreadsheets.values.get({
                spreadsheetId: args.spreadsheetId,
                range: sheet.properties.title,
            });
        } else {
            // Read first sheet by default
            response = await sheets.spreadsheets.values.get({
                spreadsheetId: args.spreadsheetId,
                range: "A:ZZ", // Read all possible columns
            });
        }

        const processedData = await processSheetData(response);

        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(processedData, null, 2),
                },
            ],
            isError: false,
        };
    } catch (error: any) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error reading spreadsheet: ${error.message}`,
                },
            ],
            isError: true,
        };
    }
}

// --- MCP Server Implementation ---
const googleDriveTools: [
    Tool<GDriveSearchInput, GoogleDriveClient>,
    Tool<GDriveReadFileInput, GoogleDriveClient>,
    Tool<GSheetsUpdateCellInput, GoogleDriveClient>,
    Tool<GSheetsReadInput, GoogleDriveClient>
] = [
    {
        ...gdriveSearchSchema,
        handler: gdriveSearchHandler,
    },
    {
        ...gdriveReadFileSchema,
        handler: gdriveReadFileHandler,
    },
    {
        ...gsheetsUpdateCellSchema,
        handler: gsheetsUpdateCellHandler,
    },
    {
        ...gsheetsReadSchema,
        handler: gsheetsReadHandler,
    },
];

class GoogleDriveMcpServer {
    private server: Server;
    private googleDriveClient: GoogleDriveClient | null = null;

    constructor() {
        this.server = new Server(
            {
                name: "google-drive-mcp-server",
                version: "0.1.0",
                description: "A Google Drive and Google Sheets integration server.",
            },
            {
                capabilities: { tools: {} },
            }
        );

        this.setupToolHandlers();

        this.server.onerror = (error) => console.error("[MCP Error]", error);
        process.on("SIGINT", async () => {
            await this.server.close();
            process.exit(0);
        });
    }

    private async initializeGoogleDriveClient() {
        try {
            const auth = await getValidCredentials();
            if (!auth) {
                console.error("Failed to obtain valid Google credentials.");
                return null;
            }
            const drive = google.drive({ version: "v3", auth });
            const sheets = google.sheets({ version: "v4", auth });
            return { drive, sheets };
        } catch (error) {
            console.error("Error initializing Google Drive client:", error);
            return null;
        }
    }

    private setupToolHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: googleDriveTools.map(({ name, description, inputSchema }) => ({
                name,
                description,
                inputSchema,
            })),
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
            if (!this.googleDriveClient) {
                throw new McpError(
                    ErrorCode.InternalError,
                    "Google Drive client not initialized."
                );
            }

            const tool = googleDriveTools.find((t) => t.name === request.params.name);
            if (!tool) {
                throw new McpError(
                    ErrorCode.MethodNotFound,
                    `Tool '${request.params.name}' not found.`
                );
            }

            try {
                const result = await tool.handler(
                    request.params.arguments as any,
                    this.googleDriveClient
                );
                return this.convertToolResponse(result);
            } catch (error: any) {
                console.error(`Error executing tool '${request.params.name}':`, error);
                return this.convertToolResponse({
                    content: [{ type: "text", text: `Error: ${error.message}` }],
                    isError: true,
                });
            }
        });
    }

    private convertToolResponse(response: InternalToolResponse) {
        return {
            _meta: {},
            content: response.content,
            isError: response.isError,
        };
    }

    async run() {
        this.googleDriveClient = await this.initializeGoogleDriveClient();
        if (!this.googleDriveClient) {
            console.error("Failed to initialize Google Drive client. Check credentials and environment variables.");
            return;
        }

        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error("Google Drive MCP server running on stdio");

        setupTokenRefresh();
    }
}

const server = new GoogleDriveMcpServer();
server.run().catch(console.error);