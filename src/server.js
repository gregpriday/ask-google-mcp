import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { ASK_GOOGLE_TOOL } from "./tool.js";

export function createAskGoogleServer({ version, askGoogleHandler }) {
  const server = new Server(
    {
      name: "ask-google",
      version,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [ASK_GOOGLE_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== ASK_GOOGLE_TOOL.name) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown tool: ${request.params.name}`
      );
    }

    return askGoogleHandler(request.params.arguments || {});
  });

  return server;
}
