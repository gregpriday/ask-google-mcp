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

  it("completes MCP handshake and returns a grounded answer", async () => {
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
    assert.ok(listResponse.result.tools.find((tool) => tool.name === "ask_google"));

    const callResponse = await sendRequest(server, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "ask_google",
        arguments: {
          question: "Who did the South African Springboks Rugby team play last and who won?",
        },
      },
    }, 60_000);

    assert.ifError(callResponse.error);
    assert.ok(callResponse.result?.content);
    const text = callResponse.result.content.find((item) => item.type === "text")?.text || "";
    assert.match(text, /Sources:/);
  });
});
