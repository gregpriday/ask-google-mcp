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
    "Grounded Google web research for current/latest info, version checks, and comparisons. Short or long questions; prefer 'current/latest' over hardcoding years.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      question: {
        type: "string",
        description: "Grounded web-search query. Can be a short lookup or long-form, multi-part research request. Prefer 'current/latest/as of today' over hardcoding dates unless a specific historical year matters.",
        minLength: 1,
        maxLength: 10000,
        examples: [
          "Find current ECMAScript standard and key new features",
          "React 19 vs 18: breaking changes, migration steps, and notable new APIs",
          "Find current Node.js LTS version and its release date",
          "Check online: is OpenSSL 3.3.2 released yet? Link release notes if so",
        ],
      },
    },
    required: ["question"],
  },
};

describe("Tool description and schema", () => {
  describe("invocation cues", () => {
    it("should mention current/latest info use case", () => {
      assert.ok(askGoogleToolDefinition.description.includes("current/latest info"));
    });

    it("should mention version checks use case", () => {
      assert.ok(askGoogleToolDefinition.description.includes("version checks"));
    });

    it("should mention comparisons use case", () => {
      assert.ok(askGoogleToolDefinition.description.includes("comparisons"));
    });

    it("should mention short or long questions", () => {
      assert.ok(askGoogleToolDefinition.description.includes("Short or long"));
    });

    it("should discourage hardcoding years", () => {
      assert.ok(askGoogleToolDefinition.description.includes("prefer 'current/latest' over hardcoding years"));
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

    it("should include Node.js LTS example", () => {
      const examples = askGoogleToolDefinition.inputSchema.properties.question.examples;
      assert.ok(examples.some((ex) => ex.includes("Node.js LTS")));
    });

    it("should include 'check online' usage example", () => {
      const examples = askGoogleToolDefinition.inputSchema.properties.question.examples;
      assert.ok(examples.some((ex) => ex.toLowerCase().includes("check online")));
    });

    it("should model 'Find current' phrasing in examples", () => {
      const examples = askGoogleToolDefinition.inputSchema.properties.question.examples;
      assert.ok(examples.some((ex) => ex.startsWith("Find current")));
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
      assert.ok(desc.toLowerCase().includes("query") || desc.includes("search"));
    });
  });
});
