// Test fixture: starts the real MCP server, then schedules an unhandled promise rejection.
// Used by server-resilience.test.js to verify the server's process handlers don't exit on
// unhandled rejections (which would torpedo all concurrent in-flight tool calls).
import "../../src/index.js";

setTimeout(() => {
  Promise.reject(new Error("simulated_unhandled_rejection"));
}, 100);
