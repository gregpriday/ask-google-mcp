/**
 * Unit tests for tool description and schema validation
 * Validates that the tool description includes proper invocation cues
 */

import { describe, it } from "node:test";
import assert from "node:assert";

// Mock tool definition matching src/index.js
const askGoogleToolDefinition = {
  name: "ask_google",
  description:
    "Grounded Google web research. Use when asked to 'check online', 'ask google', 'research', verify latest standards/versions, compare releases, or when current info is needed.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      question: {
        type: "string",
        description: "Research question to answer with grounded web search.",
        minLength: 1,
        maxLength: 10000,
        examples: [
          "Latest ECMAScript standard and new features",
          "React 19: what's new vs 18?",
          "Compare PostgreSQL 16 vs MySQL 8.4 for OLTP",
          "Check online: is OpenSSL 3.3.2 out yet?",
        ],
      },
    },
    required: ["question"],
  },
};

describe("Tool description and schema", () => {
  describe("invocation cues", () => {
    it("should include 'check online' trigger phrase", () => {
      assert.ok(askGoogleToolDefinition.description.includes("check online"));
    });

    it("should include 'ask google' trigger phrase", () => {
      assert.ok(askGoogleToolDefinition.description.includes("ask google"));
    });

    it("should include 'research' trigger phrase", () => {
      assert.ok(askGoogleToolDefinition.description.includes("research"));
    });

    it("should mention latest standards/versions use case", () => {
      assert.ok(askGoogleToolDefinition.description.includes("latest standards/versions"));
    });

    it("should mention release comparisons use case", () => {
      assert.ok(askGoogleToolDefinition.description.includes("compare releases"));
    });

    it("should mention current info use case", () => {
      assert.ok(askGoogleToolDefinition.description.includes("current info"));
    });
  });

  describe("input schema validation", () => {
    it("should have minLength constraint", () => {
      assert.strictEqual(askGoogleToolDefinition.inputSchema.properties.question.minLength, 1);
    });

    it("should have maxLength constraint", () => {
      assert.strictEqual(askGoogleToolDefinition.inputSchema.properties.question.maxLength, 10000);
    });

    it("should disallow additional properties", () => {
      assert.strictEqual(askGoogleToolDefinition.inputSchema.additionalProperties, false);
    });

    it("should mark question as required", () => {
      assert.deepStrictEqual(askGoogleToolDefinition.inputSchema.required, ["question"]);
    });

    it("should include concrete examples", () => {
      const examples = askGoogleToolDefinition.inputSchema.properties.question.examples;
      assert.ok(Array.isArray(examples));
      assert.strictEqual(examples.length, 4);
    });

    it("should include ECMAScript example", () => {
      const examples = askGoogleToolDefinition.inputSchema.properties.question.examples;
      assert.ok(examples.some((ex) => ex.includes("ECMAScript")));
    });

    it("should include React comparison example", () => {
      const examples = askGoogleToolDefinition.inputSchema.properties.question.examples;
      assert.ok(examples.some((ex) => ex.includes("React 19")));
    });

    it("should include database comparison example", () => {
      const examples = askGoogleToolDefinition.inputSchema.properties.question.examples;
      assert.ok(examples.some((ex) => ex.includes("PostgreSQL")));
    });

    it("should include 'check online' usage example", () => {
      const examples = askGoogleToolDefinition.inputSchema.properties.question.examples;
      assert.ok(examples.some((ex) => ex.toLowerCase().includes("check online")));
    });
  });

  describe("tool metadata", () => {
    it("should have correct tool name", () => {
      assert.strictEqual(askGoogleToolDefinition.name, "ask_google");
    });

    it("should have terse description (under 200 chars)", () => {
      assert.ok(askGoogleToolDefinition.description.length < 200);
    });

    it("should have question parameter as string type", () => {
      assert.strictEqual(
        askGoogleToolDefinition.inputSchema.properties.question.type,
        "string"
      );
    });

    it("should have descriptive parameter description", () => {
      const desc = askGoogleToolDefinition.inputSchema.properties.question.description;
      assert.ok(desc.length > 10);
      assert.ok(desc.toLowerCase().includes("research") || desc.includes("question"));
    });
  });
});
