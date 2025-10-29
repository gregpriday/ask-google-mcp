/**
 * Unit tests for ask_google tool handler
 * Tests input validation, error handling, and response formatting
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert";

// Mock the Gemini API
class MockGenerativeModel {
  constructor(responseData) {
    this.responseData = responseData;
  }

  async generateContent(question) {
    if (this.responseData.shouldThrow) {
      throw new Error(this.responseData.error);
    }

    return {
      response: {
        text: () => this.responseData.text,
        candidates: this.responseData.candidates || [],
      },
    };
  }
}

// Simulate the tool handler logic (extracted for testing)
async function handleAskGoogle(question, model) {
  // Input validation (matching src/index.js)
  if (!question) {
    throw new Error("Missing required parameter: question");
  }

  if (typeof question !== "string") {
    throw new Error("Question must be a string");
  }

  if (question.trim().length === 0) {
    throw new Error("Question cannot be empty");
  }

  if (question.length > 10000) {
    throw new Error("Question exceeds maximum length of 10000 characters");
  }

  try {
    const result = await model.generateContent(question);
    const response = result.response;

    // Extract grounding metadata
    const metadata = response.candidates?.[0]?.groundingMetadata;
    const sources =
      metadata?.groundingChunks?.map((chunk) => ({
        title: chunk.web?.title || "Unknown",
        url: chunk.web?.uri || "",
        domain: chunk.web?.domain || "",
      })) || [];

    const searches = metadata?.webSearchQueries || [];

    // Build response
    let fullResponse = response.text();

    if (sources.length > 0) {
      fullResponse += "\n\n---\n**Sources:**\n";
      sources.forEach((source, idx) => {
        fullResponse += `\n${idx + 1}. [${source.title}](${source.url})`;
      });
    }

    if (searches.length > 0) {
      fullResponse += "\n\n**Search queries performed:**\n";
      searches.forEach((query, idx) => {
        fullResponse += `\n${idx + 1}. "${query}"`;
      });
    }

    return {
      content: [
        {
          type: "text",
          text: fullResponse,
        },
      ],
    };
  } catch (error) {
    // MCP-specific error categorization (case-insensitive)
    const errorMessage = error.message || "Generation failed";
    const lowerMessage = errorMessage.toLowerCase();

    if (lowerMessage.includes("api key")) {
      throw new Error(`[AUTH_ERROR] Invalid or missing API key: ${errorMessage}`);
    } else if (lowerMessage.includes("quota") || lowerMessage.includes("rate limit")) {
      throw new Error(`[QUOTA_ERROR] API quota exceeded: ${errorMessage}`);
    } else if (lowerMessage.includes("timeout")) {
      throw new Error(`[TIMEOUT_ERROR] Request timed out: ${errorMessage}`);
    } else {
      throw new Error(`[API_ERROR] Gemini API error: ${errorMessage}`);
    }
  }
}

describe("ask_google tool handler", () => {
  describe("input validation", () => {
    it("should reject missing question", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      await assert.rejects(
        async () => await handleAskGoogle(null, model),
        {
          message: "Missing required parameter: question",
        }
      );
    });

    it("should reject undefined question", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      await assert.rejects(
        async () => await handleAskGoogle(undefined, model),
        {
          message: "Missing required parameter: question",
        }
      );
    });

    it("should reject non-string question", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      await assert.rejects(
        async () => await handleAskGoogle(123, model),
        {
          message: "Question must be a string",
        }
      );
    });

    it("should reject empty string question", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      await assert.rejects(
        async () => await handleAskGoogle("   ", model),
        {
          message: "Question cannot be empty",
        }
      );
    });

    it("should reject questions exceeding max length", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      const longQuestion = "a".repeat(10001);

      await assert.rejects(
        async () => await handleAskGoogle(longQuestion, model),
        {
          message: "Question exceeds maximum length of 10000 characters",
        }
      );
    });

    it("should accept valid question", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      const result = await handleAskGoogle("What is Node.js?", model);

      assert.ok(result);
      assert.ok(result.content);
      assert.strictEqual(result.content[0].type, "text");
    });
  });

  describe("successful responses", () => {
    it("should return basic response without sources", async () => {
      const model = new MockGenerativeModel({
        text: "Node.js is a JavaScript runtime.",
        candidates: [],
      });

      const result = await handleAskGoogle("What is Node.js?", model);

      assert.strictEqual(result.content[0].type, "text");
      assert.strictEqual(
        result.content[0].text,
        "Node.js is a JavaScript runtime."
      );
    });

    it("should include sources when available", async () => {
      const model = new MockGenerativeModel({
        text: "Node.js is a JavaScript runtime.",
        candidates: [
          {
            groundingMetadata: {
              groundingChunks: [
                {
                  web: {
                    title: "Node.js Official Docs",
                    uri: "https://nodejs.org/docs",
                    domain: "nodejs.org",
                  },
                },
              ],
            },
          },
        ],
      });

      const result = await handleAskGoogle("What is Node.js?", model);

      assert.ok(result.content[0].text.includes("**Sources:**"));
      assert.ok(result.content[0].text.includes("Node.js Official Docs"));
      assert.ok(result.content[0].text.includes("https://nodejs.org/docs"));
    });

    it("should include search queries when available", async () => {
      const model = new MockGenerativeModel({
        text: "Node.js is a JavaScript runtime.",
        candidates: [
          {
            groundingMetadata: {
              webSearchQueries: ["What is Node.js", "Node.js runtime"],
            },
          },
        ],
      });

      const result = await handleAskGoogle("What is Node.js?", model);

      assert.ok(result.content[0].text.includes("**Search queries performed:**"));
      assert.ok(result.content[0].text.includes("What is Node.js"));
      assert.ok(result.content[0].text.includes("Node.js runtime"));
    });

    it("should include both sources and search queries", async () => {
      const model = new MockGenerativeModel({
        text: "Node.js is a JavaScript runtime.",
        candidates: [
          {
            groundingMetadata: {
              groundingChunks: [
                {
                  web: {
                    title: "Node.js Docs",
                    uri: "https://nodejs.org",
                    domain: "nodejs.org",
                  },
                },
              ],
              webSearchQueries: ["Node.js overview"],
            },
          },
        ],
      });

      const result = await handleAskGoogle("What is Node.js?", model);

      assert.ok(result.content[0].text.includes("**Sources:**"));
      assert.ok(result.content[0].text.includes("**Search queries performed:**"));
    });
  });

  describe("error handling", () => {
    it("should categorize auth errors", async () => {
      const model = new MockGenerativeModel({
        shouldThrow: true,
        error: "Invalid API key provided",
      });

      await assert.rejects(
        async () => await handleAskGoogle("test question", model),
        {
          message: /\[AUTH_ERROR\]/,
        }
      );
    });

    it("should categorize quota errors", async () => {
      const model = new MockGenerativeModel({
        shouldThrow: true,
        error: "API quota exceeded for this project",
      });

      await assert.rejects(
        async () => await handleAskGoogle("test question", model),
        {
          message: /\[QUOTA_ERROR\]/,
        }
      );
    });

    it("should categorize rate limit errors", async () => {
      const model = new MockGenerativeModel({
        shouldThrow: true,
        error: "Rate limit exceeded, please try again later",
      });

      await assert.rejects(
        async () => await handleAskGoogle("test question", model),
        {
          message: /\[QUOTA_ERROR\]/,
        }
      );
    });

    it("should categorize timeout errors", async () => {
      const model = new MockGenerativeModel({
        shouldThrow: true,
        error: "Request timeout after 30 seconds",
      });

      await assert.rejects(
        async () => await handleAskGoogle("test question", model),
        {
          message: /\[TIMEOUT_ERROR\]/,
        }
      );
    });

    it("should categorize generic API errors", async () => {
      const model = new MockGenerativeModel({
        shouldThrow: true,
        error: "Something went wrong with the API",
      });

      await assert.rejects(
        async () => await handleAskGoogle("test question", model),
        {
          message: /\[API_ERROR\]/,
        }
      );
    });
  });

  describe("edge cases", () => {
    it("should handle questions at max length boundary", async () => {
      const model = new MockGenerativeModel({
        text: "Response",
      });

      const maxLengthQuestion = "a".repeat(10000);
      const result = await handleAskGoogle(maxLengthQuestion, model);

      assert.ok(result);
      assert.strictEqual(result.content[0].type, "text");
    });

    it("should handle special characters in questions", async () => {
      const model = new MockGenerativeModel({
        text: "Response",
      });

      const specialQuestion = 'What is "Node.js"? <script>alert("test")</script>';
      const result = await handleAskGoogle(specialQuestion, model);

      assert.ok(result);
      assert.strictEqual(result.content[0].type, "text");
    });

    it("should handle Unicode characters", async () => {
      const model = new MockGenerativeModel({
        text: "Response",
      });

      const unicodeQuestion = "What is Node.js? 你好 世界 🚀";
      const result = await handleAskGoogle(unicodeQuestion, model);

      assert.ok(result);
      assert.strictEqual(result.content[0].type, "text");
    });
  });
});
