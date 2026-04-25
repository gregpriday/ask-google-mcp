import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { ASK_GOOGLE_TOOL } from "./tool.js";

let nextRequestSeq = 0;

// Builds the CallTool handler with request-id logging and a top-level safety net. Exported
// so unit tests can drive it directly without spawning a child process.
export function createCallToolHandler({
  askGoogleHandler,
  notifyProgress: notifyProgressFactory,
  logger = console,
  now = () => new Date(),
}) {
  return async function handleCallTool(request) {
    if (request.params.name !== ASK_GOOGLE_TOOL.name) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown tool: ${request.params.name}`
      );
    }

    const progressToken = request.params?._meta?.progressToken;
    const notifyProgress =
      progressToken !== undefined && progressToken !== null && notifyProgressFactory
        ? notifyProgressFactory(progressToken)
        : null;

    nextRequestSeq += 1;
    const requestSeq = nextRequestSeq;
    const startedAt = Date.now();
    logger.error(
      `[${now().toISOString()}] [REQ ${requestSeq}] start tool=${request.params.name}`
    );

    try {
      const result = await askGoogleHandler(request.params.arguments || {}, { notifyProgress });
      logger.error(
        `[${now().toISOString()}] [REQ ${requestSeq}] end ok=${!result?.isError} ` +
          `elapsed_ms=${Date.now() - startedAt}`
      );
      return result;
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      // Validation errors come through as McpError and need to propagate as protocol errors
      // so the SDK formats them correctly. The transport stays open.
      if (error?.name === "McpError") {
        logger.error(
          `[${now().toISOString()}] [REQ ${requestSeq}] mcp_error elapsed_ms=${elapsedMs} ` +
            `message=${JSON.stringify(error.message)}`
        );
        throw error;
      }
      // Anything else is a bug — the inner handler should have caught it. Convert to an
      // error result instead of letting it escape, so a concurrent call's failure can never
      // close the transport on every other in-flight call.
      logger.error(
        `[${now().toISOString()}] [REQ ${requestSeq}] unexpected_throw elapsed_ms=${elapsedMs} ` +
          `message=${JSON.stringify(error?.message ?? String(error))}`
      );
      if (error?.stack) {
        logger.error(error.stack);
      }
      return {
        content: [
          {
            type: "text",
            text: `[INTERNAL_ERROR] Unexpected server error: ${error?.message ?? "unknown"}. Retry the call.`,
          },
        ],
        isError: true,
      };
    }
  };
}

export function createAskGoogleServer({ version, askGoogleHandler, logger = console }) {
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

  // Per MCP spec, tools only emit progress notifications when the client opts in by passing
  // a progressToken in _meta. If no token is present, we skip emission entirely.
  const notifyProgressFactory = (progressToken) =>
    ({ progress, total, message }) => {
      // Swallow notification errors — a flaky notification channel must not break the call.
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
    };

  server.setRequestHandler(
    CallToolRequestSchema,
    createCallToolHandler({ askGoogleHandler, notifyProgress: notifyProgressFactory, logger })
  );

  return server;
}
