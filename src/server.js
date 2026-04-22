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

    // Per MCP spec, tools only emit progress notifications when the client opts in by
    // passing a progressToken in _meta. If no token is present, we skip emission entirely.
    const progressToken = request.params?._meta?.progressToken;
    const notifyProgress =
      progressToken !== undefined && progressToken !== null
        ? ({ progress, total, message }) => {
            // Swallow notification errors — a flaky notification channel must not break
            // the tool call itself.
            try {
              server.notification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress,
                  ...(total !== undefined ? { total } : {}),
                  ...(message !== undefined ? { message } : {}),
                },
              });
            } catch {
              // no-op
            }
          }
        : null;

    return askGoogleHandler(request.params.arguments || {}, { notifyProgress });
  });

  return server;
}
