import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { sendNotification, sendRequest } from "../support/mcp-stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..", "..");
const shouldRun = process.env.RUN_LIVE_TESTS === "1" && Boolean(process.env.GOOGLE_API_KEY);
const describeLive = shouldRun ? describe : describe.skip;

describeLive("live Gemini MCP integration", () => {
  let server;

  before(async () => {
    server = spawn("node", ["src/index.js"], {
      cwd: projectRoot,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  after(() => {
    if (server) {
      server.kill();
    }
  });

  it("completes MCP handshake and lists tools", async () => {
    const initResponse = await sendRequest(server, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "live-test", version: "1.0.0" },
        capabilities: {},
      },
    });

    assert.ok(initResponse.result);
    assert.ok(initResponse.result.serverInfo);

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

    const tools = listResponse.result.tools;
    assert.ok(Array.isArray(tools));
    const askGoogle = tools.find((tool) => tool.name === "ask_google");
    assert.ok(askGoogle, "ask_google tool should be listed");
    assert.ok(askGoogle.inputSchema, "tool should have an input schema");
  });

  it("returns a grounded answer for a simple query", async () => {
    const callResponse = await sendRequest(server, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "ask_google",
        arguments: {
          question: "What is the capital of France?",
          model: "flash-lite",
        },
      },
    }, 30_000);

    assert.ifError(callResponse.error);
    assert.ok(callResponse.result?.content);
    const text = callResponse.result.content.find((item) => item.type === "text")?.text || "";
    assert.ok(text.length > 0, "response should not be empty");
    assert.match(text, /Paris/i, "response should mention Paris");
  });

  it("returns an error for an unknown tool", async () => {
    const callResponse = await sendRequest(server, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "nonexistent_tool",
        arguments: {},
      },
    });

    assert.ok(callResponse.error);
  });
});
