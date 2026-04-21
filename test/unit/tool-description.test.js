import { describe, it } from "node:test";
import assert from "node:assert";
import { ASK_GOOGLE_TOOL } from "../../src/tool.js";
import { ENABLED_MODELS, MAX_QUESTION_LENGTH } from "../../src/config.js";

describe("ask_google tool definition", () => {
  it("uses the production tool name", () => {
    assert.strictEqual(ASK_GOOGLE_TOOL.name, "ask_google");
  });

  it("includes the expected invocation cues", () => {
    assert.match(ASK_GOOGLE_TOOL.description, /current\/latest/);
    assert.match(ASK_GOOGLE_TOOL.description, /Google Search grounding/);
    assert.match(ASK_GOOGLE_TOOL.description, /short lookups/);
    assert.match(ASK_GOOGLE_TOOL.description, /research briefs/);
  });

  it("keeps the schema strict", () => {
    assert.strictEqual(ASK_GOOGLE_TOOL.inputSchema.additionalProperties, false);
  });

  it("avoids top-level anyOf/oneOf/allOf (unsupported by Claude API tool schemas)", () => {
    assert.strictEqual(ASK_GOOGLE_TOOL.inputSchema.anyOf, undefined);
    assert.strictEqual(ASK_GOOGLE_TOOL.inputSchema.oneOf, undefined);
    assert.strictEqual(ASK_GOOGLE_TOOL.inputSchema.allOf, undefined);
  });

  it("exposes 'query' as an alias for 'question'", () => {
    const { query, question } = ASK_GOOGLE_TOOL.inputSchema.properties;
    assert.ok(query, "expected a 'query' property on the schema");
    assert.strictEqual(query.type, "string");
    assert.strictEqual(query.maxLength, question.maxLength);
    assert.match(query.description, /alias/i);
  });

  it("advertises the runtime limits from production config", () => {
    assert.strictEqual(
      ASK_GOOGLE_TOOL.inputSchema.properties.question.maxLength,
      MAX_QUESTION_LENGTH
    );
    assert.deepStrictEqual(
      ASK_GOOGLE_TOOL.inputSchema.properties.model.enum,
      ENABLED_MODELS
    );
  });

  it("documents that output_file is gated by configuration", () => {
    assert.match(
      ASK_GOOGLE_TOOL.inputSchema.properties.output_file.description,
      /ASK_GOOGLE_ALLOW_FILE_OUTPUT=true/
    );
  });
});
