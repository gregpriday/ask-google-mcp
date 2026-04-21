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

async function handshake(server) {
  await sendRequest(server, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "unit-test", version: "1.0.0" },
      capabilities: {},
    },
  });

  sendNotification(server, {
    jsonrpc: "2.0",
    method: "initialized",
    params: {},
  });
}

describe("ASK_GOOGLE_ENABLED_MODELS filtering", () => {
  it("restricts the tool's model enum and default when only some aliases are enabled", async () => {
    const server = spawn("node", ["src/index.js"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        GOOGLE_API_KEY: "",
        ASK_GOOGLE_ENABLED_MODELS: "flash,flash-lite",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    server.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await handshake(server);

      const listResponse = await sendRequest(server, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });

      const tool = listResponse.result.tools.find((t) => t.name === "ask_google");
      assert.ok(tool);
      assert.deepStrictEqual(tool.inputSchema.properties.model.enum, ["flash", "flash-lite"]);
      assert.strictEqual(tool.inputSchema.properties.model.default, "flash");
      assert.match(stderr, /default model falls back to "flash"/);
    } finally {
      server.kill();
    }
  });

  it("rejects tool calls that request a disabled model", async () => {
    const server = spawn("node", ["src/index.js"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        GOOGLE_API_KEY: "",
        ASK_GOOGLE_ENABLED_MODELS: "flash",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await handshake(server);

      const callResponse = await sendRequest(server, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "ask_google",
          arguments: {
            question: "anything",
            model: "pro",
          },
        },
      });

      assert.ok(callResponse.error);
      assert.match(callResponse.error.message, /model must be one of: flash/);
    } finally {
      server.kill();
    }
  });

  it("exits with a non-zero code when no valid aliases remain", async () => {
    const server = spawn("node", ["src/index.js"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        GOOGLE_API_KEY: "",
        ASK_GOOGLE_ENABLED_MODELS: "bogus",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    server.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const exitCode = await new Promise((resolve) => {
      server.on("exit", (code) => resolve(code));
    });

    assert.notStrictEqual(exitCode, 0);
    assert.match(stderr, /ASK_GOOGLE_ENABLED_MODELS must include at least one of/);
  });

  it("warns on unknown aliases but continues when at least one valid alias remains", async () => {
    const server = spawn("node", ["src/index.js"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        GOOGLE_API_KEY: "",
        ASK_GOOGLE_ENABLED_MODELS: "flash,bogus",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    server.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await handshake(server);

      const listResponse = await sendRequest(server, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });

      const tool = listResponse.result.tools.find((t) => t.name === "ask_google");
      assert.ok(tool);
      assert.deepStrictEqual(tool.inputSchema.properties.model.enum, ["flash"]);
      assert.match(stderr, /unknown alias "bogus"/);
    } finally {
      server.kill();
    }
  });
});
