import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createCallToolHandler } from "../../src/server.js";
import { sendNotification, sendRequest } from "../support/mcp-stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..", "..");

function makeRequest(args = { question: "test" }, name = "ask_google") {
  return { params: { name, arguments: args } };
}

function makeLogger() {
  const lines = [];
  return {
    lines,
    error: (...parts) => lines.push(parts.join(" ")),
  };
}

describe("createCallToolHandler — resilience", () => {
  it("logs request lifecycle (start + end) on success", async () => {
    const logger = makeLogger();
    const handler = createCallToolHandler({
      askGoogleHandler: async () => ({ content: [{ type: "text", text: "ok" }] }),
      logger,
    });

    const result = await handler(makeRequest());

    assert.strictEqual(result.content[0].text, "ok");
    assert.ok(
      logger.lines.some((line) => /\[REQ \d+\] start tool=ask_google/.test(line)),
      `expected start log, got: ${logger.lines.join("\n")}`
    );
    assert.ok(
      logger.lines.some((line) => /\[REQ \d+\] end ok=true elapsed_ms=\d+/.test(line)),
      `expected end log, got: ${logger.lines.join("\n")}`
    );
  });

  it("converts unexpected handler throws into MCP error results without rethrowing", async () => {
    const logger = makeLogger();
    const handler = createCallToolHandler({
      askGoogleHandler: async () => {
        throw new Error("boom — simulated SDK fault");
      },
      logger,
    });

    const result = await handler(makeRequest());

    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /\[INTERNAL_ERROR\]/);
    assert.match(result.content[0].text, /boom — simulated SDK fault/);
    assert.ok(
      logger.lines.some((line) => /\[REQ \d+\] unexpected_throw/.test(line)),
      `expected unexpected_throw log, got: ${logger.lines.join("\n")}`
    );
  });

  it("still propagates McpError as a protocol error so the SDK formats it correctly", async () => {
    const logger = makeLogger();
    const { McpError, ErrorCode } = await import(
      "@modelcontextprotocol/sdk/types.js"
    );
    const handler = createCallToolHandler({
      askGoogleHandler: async () => {
        throw new McpError(ErrorCode.InvalidParams, "bad input");
      },
      logger,
    });

    await assert.rejects(handler(makeRequest()), /bad input/);
    assert.ok(
      logger.lines.some((line) => /\[REQ \d+\] mcp_error/.test(line)),
      `expected mcp_error log, got: ${logger.lines.join("\n")}`
    );
  });

  it("returns an error result for an unknown tool name (still an McpError)", async () => {
    const handler = createCallToolHandler({
      askGoogleHandler: async () => ({ content: [{ type: "text", text: "ok" }] }),
      logger: makeLogger(),
    });

    await assert.rejects(handler(makeRequest({}, "not_a_real_tool")), /Unknown tool/);
  });

  it("survives concurrent calls when one of them throws unexpectedly", async () => {
    // The bug we're guarding against: a concurrent call's unexpected throw should never
    // affect sibling calls. Three good ones + one bad one — the good ones must still resolve.
    const handler = createCallToolHandler({
      askGoogleHandler: async (args) => {
        if (args.question === "boom") {
          throw new Error("simulated transient SDK fault");
        }
        // Tiny delay so all four overlap.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { content: [{ type: "text", text: `ok:${args.question}` }] };
      },
      logger: makeLogger(),
    });

    const results = await Promise.all([
      handler(makeRequest({ question: "a" })),
      handler(makeRequest({ question: "b" })),
      handler(makeRequest({ question: "boom" })),
      handler(makeRequest({ question: "c" })),
    ]);

    assert.strictEqual(results[0].content[0].text, "ok:a");
    assert.strictEqual(results[1].content[0].text, "ok:b");
    assert.strictEqual(results[2].isError, true);
    assert.match(results[2].content[0].text, /\[INTERNAL_ERROR\]/);
    assert.strictEqual(results[3].content[0].text, "ok:c");
  });
});

// Verifies the running server doesn't kill itself when the SDK (or anything else) emits an
// unhandled promise rejection. We stuff a rejection into a no-op variable so it has no
// awaiter, then send a tool call and confirm the server is still responsive.
describe("server process — unhandled rejection resilience", () => {
  let server;
  let stderr = "";

  before(async () => {
    server = spawn("node", ["test/support/server-with-rejection.js"], {
      cwd: projectRoot,
      env: { ...process.env, GOOGLE_API_KEY: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    server.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    // Wait long enough for the rejection to fire (fixture schedules it at +100ms).
    await new Promise((resolve) => setTimeout(resolve, 400));
  });

  after(() => {
    if (server && !server.killed) {
      server.kill();
    }
  });

  it("logs the rejection but stays alive and continues serving requests", async () => {
    assert.strictEqual(server.exitCode, null, "server should still be running");
    assert.match(
      stderr,
      /\[UNHANDLED_REJECTION\] count=\d+ message="simulated_unhandled_rejection"/,
      `expected UNHANDLED_REJECTION log, got stderr:\n${stderr}`
    );

    // Now confirm we can still talk to the server.
    const initResponse = await sendRequest(server, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "unit-test", version: "1.0.0" },
        capabilities: {},
      },
    });
    assert.ok(initResponse.result, "expected initialize to succeed after rejection");

    sendNotification(server, {
      jsonrpc: "2.0",
      method: "initialized",
      params: {},
    });

    const listResponse = await sendRequest(server, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    assert.ok(Array.isArray(listResponse.result.tools));
  });
});
