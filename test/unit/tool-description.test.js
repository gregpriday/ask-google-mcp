import { describe, it } from "node:test";
import assert from "node:assert";
import { ASK_GOOGLE_TOOL } from "../../src/tool.js";
import { MAX_QUESTION_LENGTH, MODEL_PARAM_VALUES } from "../../src/config.js";

describe("ask_google tool definition", () => {
  it("uses the production tool name", () => {
    assert.strictEqual(ASK_GOOGLE_TOOL.name, "ask_google");
  });

  it("includes the expected invocation cues", () => {
    assert.match(ASK_GOOGLE_TOOL.description, /current\/latest/);
    assert.match(ASK_GOOGLE_TOOL.description, /Google Search grounding/);
    // Trigger phrasing: post-training gap-filling (post-date your training, post-cutoff, etc).
    assert.match(ASK_GOOGLE_TOOL.description, /post[-\s]?(training|date|cutoff)/i);
    // Negative list prevents over-invocation for stable facts.
    assert.match(ASK_GOOGLE_TOOL.description, /Do not use/i);
  });

  it("mentions both short lookups and research briefs in the input schema", () => {
    const qDesc = ASK_GOOGLE_TOOL.inputSchema.properties.question.description;
    assert.match(qDesc, /short lookups/i);
    assert.match(qDesc, /research briefs/i);
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
    // With the router enabled by default, MODEL_PARAM_VALUES includes "auto" in addition to the
    // concrete enabled aliases.
    assert.deepStrictEqual(
      ASK_GOOGLE_TOOL.inputSchema.properties.model.enum,
      MODEL_PARAM_VALUES
    );
  });

  it("publishes MCP tool annotations for read-only/idempotent/open-world behavior", () => {
    const a = ASK_GOOGLE_TOOL.annotations;
    assert.ok(a, "expected annotations on the tool card");
    assert.strictEqual(a.readOnlyHint, true);
    assert.strictEqual(a.idempotentHint, true);
    assert.strictEqual(a.openWorldHint, true);
    assert.strictEqual(a.destructiveHint, false);
    assert.ok(typeof a.title === "string" && a.title.length > 0);
  });

  it("publishes a structured outputSchema alongside the markdown response", () => {
    const schema = ASK_GOOGLE_TOOL.outputSchema;
    assert.ok(schema, "expected an outputSchema");
    assert.strictEqual(schema.type, "object");
    assert.ok(schema.properties.answer);
    assert.ok(schema.properties.sources);
    assert.ok(schema.properties.search_queries);
    assert.ok(schema.properties.diagnostics);
    assert.deepStrictEqual(schema.required, ["answer"]);
  });
});
