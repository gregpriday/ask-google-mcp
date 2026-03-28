import { describe, it } from "node:test";
import assert from "node:assert";
import { ASK_GOOGLE_TOOL } from "../../src/tool.js";
import { MAX_QUESTION_LENGTH, VALID_MODELS } from "../../src/config.js";

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
    assert.deepStrictEqual(ASK_GOOGLE_TOOL.inputSchema.required, ["question"]);
  });

  it("advertises the runtime limits from production config", () => {
    assert.strictEqual(
      ASK_GOOGLE_TOOL.inputSchema.properties.question.maxLength,
      MAX_QUESTION_LENGTH
    );
    assert.deepStrictEqual(
      ASK_GOOGLE_TOOL.inputSchema.properties.model.enum,
      VALID_MODELS
    );
  });

  it("documents that output_file is gated by configuration", () => {
    assert.match(
      ASK_GOOGLE_TOOL.inputSchema.properties.output_file.description,
      /ASK_GOOGLE_ALLOW_FILE_OUTPUT=true/
    );
  });
});
