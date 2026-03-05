import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { sendNotification, sendRequest } from "../support/mcp-stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..", "..");

describe("stdio server without GOOGLE_API_KEY", () => {
  let server;

  before(async () => {
    server = spawn("node", ["src/index.js"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        GOOGLE_API_KEY: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    await new Promise((resolve) => setTimeout(resolve, 250));
  });

  after(() => {
    if (server) {
      server.kill();
    }
  });

  it("initializes and lists tools", async () => {
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

    assert.ok(Array.isArray(listResponse.result.tools));
    assert.ok(listResponse.result.tools.find((tool) => tool.name === "ask_google"));
  });

  it("returns an auth error only when the tool is called", async () => {
    const callResponse = await sendRequest(server, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "ask_google",
        arguments: {
          question: "What is the latest version of Node.js?",
        },
      },
    });

    assert.ok(callResponse.error);
    assert.match(callResponse.error.message, /\[AUTH_ERROR\]/);
  });
});
