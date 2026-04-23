import { DEFAULT_MODEL, ENABLED_MODELS, MAX_QUESTION_LENGTH, MODEL_ALIASES } from "./config.js";
import { createInvalidParamsError } from "./errors.js";
import { wrapUntrusted } from "./sanitize.js";

export const ASK_GOOGLE_TOOL = Object.freeze({
  name: "ask_google",
  description:
    "Ask an AI researcher with live Google Search grounding (Gemini). Use when you need current/latest facts that post-date your training: versions, releases, recent API or docs changes, breaking news, changelogs, on-demand web research. Do not use for stable language syntax, historical facts, or knowledge already in your training data. Accepts short lookups or multi-paragraph research briefs.",
  annotations: {
    title: "Ask Google (Gemini + Search Grounding)",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
    destructiveHint: false,
  },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      question: {
        type: "string",
        description:
          "Your question for the AI researcher. Short lookups or multi-paragraph research briefs both work. Prefer 'current/latest/as of today' over hardcoding dates unless a specific historical year matters. `query` is accepted as an alias.",
        minLength: 1,
        maxLength: MAX_QUESTION_LENGTH,
        examples: [
          "Find current ECMAScript standard and key new features",
          "React 19 vs 18: breaking changes, migration steps, and notable new APIs",
          "Find current Node.js LTS version and its release date",
          "Check online: is OpenSSL 3.3.2 released yet? Link release notes if so",
        ],
      },
      query: {
        type: "string",
        description:
          "Alias for `question`. Accepted for compatibility with callers that use the name `query`; prefer `question`. Do not set both at once.",
        minLength: 1,
        maxLength: MAX_QUESTION_LENGTH,
      },
      output_file: {
        type: "string",
        description:
          "Optional path to write the response (also returned inline). Requires ASK_GOOGLE_ALLOW_FILE_OUTPUT=true. Relative paths resolve under ASK_GOOGLE_OUTPUT_DIR or the current working directory.",
        examples: [
          "./docs/research.md",
          "output/gemini-response.txt",
          "/safe/base/dir/research.md",
        ],
      },
      model: {
        type: "string",
        description: `Gemini model: 'pro' for deeper synthesis, 'flash' for quick lookups, 'flash-lite' for cheapest/fastest simple facts. Default: '${DEFAULT_MODEL}'.`,
        enum: ENABLED_MODELS,
        default: DEFAULT_MODEL,
        examples: ENABLED_MODELS,
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      answer: { type: "string" },
      sources: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            url: { type: "string" },
            domain: { type: "string" },
          },
          required: ["title", "url"],
        },
      },
      search_queries: {
        type: "array",
        items: { type: "string" },
      },
      diagnostics: {
        type: "object",
        additionalProperties: true,
        properties: {
          model: { type: "string" },
          fell_back: { type: "boolean" },
          attempts: { type: "integer" },
          total_attempts: { type: "integer" },
          duration_ms: { type: "integer" },
          ttft_ms: { type: ["integer", "null"] },
          search_queries_count: { type: "integer" },
        },
      },
      file_write_error: { type: "string" },
    },
    required: ["answer"],
  },
});

export function validateAskGoogleArguments(rawArgs = {}) {
  const hasQuestion = rawArgs?.question !== undefined && rawArgs?.question !== null;
  const hasQuery = rawArgs?.query !== undefined && rawArgs?.query !== null;

  if (hasQuestion && hasQuery) {
    throw createInvalidParamsError(
      "Provide either 'question' or 'query' (alias), not both"
    );
  }

  const question = hasQuestion ? rawArgs.question : rawArgs?.query;
  const outputFile = rawArgs?.output_file;
  const model = rawArgs?.model ?? DEFAULT_MODEL;

  if (!hasQuestion && !hasQuery) {
    throw createInvalidParamsError("Missing required parameter: question");
  }

  if (typeof question !== "string") {
    throw createInvalidParamsError("Question must be a string");
  }

  if (question.trim().length === 0) {
    throw createInvalidParamsError("Question cannot be empty");
  }

  if (question.length > MAX_QUESTION_LENGTH) {
    throw createInvalidParamsError(
      `Question exceeds maximum length of ${MAX_QUESTION_LENGTH} characters`
    );
  }

  if (outputFile !== undefined && outputFile !== null) {
    if (typeof outputFile !== "string") {
      throw createInvalidParamsError("output_file must be a string");
    }

    if (outputFile.trim().length === 0) {
      throw createInvalidParamsError("output_file cannot be empty");
    }
  }

  if (!ENABLED_MODELS.includes(model)) {
    throw createInvalidParamsError(
      `model must be one of: ${ENABLED_MODELS.join(", ")}. Got: ${model}`
    );
  }

  return {
    question,
    outputFile,
    model,
  };
}

export function resolveModelId(model) {
  return MODEL_ALIASES[model];
}

export function extractGroundingData(responseLike) {
  // Accept three shapes: a bare groundingMetadata object (new SDK streaming aggregate), a
  // wrapper with `.groundingMetadata`, or a full response with `.candidates[0].groundingMetadata`.
  const isBareMetadata =
    responseLike &&
    (responseLike.groundingChunks !== undefined ||
      responseLike.webSearchQueries !== undefined ||
      responseLike.searchEntryPoint !== undefined);
  const metadata = isBareMetadata
    ? responseLike
    : responseLike?.groundingMetadata ?? responseLike?.candidates?.[0]?.groundingMetadata;
  const rawSources =
    metadata?.groundingChunks?.map((chunk) => ({
      title: chunk.web?.title || "Unknown",
      url: chunk.web?.uri || "",
      domain: chunk.web?.domain || "",
    })) || [];

  const seenUrls = new Set();
  const sources = rawSources
    .filter((source) => {
      if (!source.url || seenUrls.has(source.url)) {
        return false;
      }

      seenUrls.add(source.url);
      return true;
    })
    .slice(0, 12);

  const searches = (metadata?.webSearchQueries || []).slice(0, 8);
  return { sources, searches };
}

export function buildToolText(
  text,
  { sources = [], searches = [], fileWriteError, diagnostics } = {}
) {
  let fullResponse = wrapUntrusted(text);

  if (sources.length > 0) {
    fullResponse += "\n\n---\n**Sources:**\n";
    sources.forEach((source, index) => {
      fullResponse += `\n${index + 1}. [${source.title}](${source.url})`;
    });
  }

  if (searches.length > 0) {
    fullResponse += "\n\n**Search queries performed:**\n";
    searches.forEach((query, index) => {
      fullResponse += `\n${index + 1}. \"${query}\"`;
    });
  }

  if (fileWriteError) {
    fullResponse += `\n\n---\n**Note:** ${fileWriteError}`;
  }

  if (diagnostics) {
    fullResponse += `\n\n---\n${formatDiagnostics(diagnostics)}`;
  }

  return fullResponse;
}

export function buildStructuredContent(
  text,
  { sources = [], searches = [], fileWriteError, diagnostics } = {}
) {
  const result = {
    answer: text,
    sources,
    search_queries: [...searches],
    diagnostics: diagnostics
      ? {
          model: diagnostics.model,
          fell_back: Boolean(diagnostics.fellBack),
          attempts: diagnostics.attempts,
          total_attempts: diagnostics.totalAttempts,
          duration_ms: diagnostics.durationMs,
          ttft_ms: diagnostics.ttftMs ?? null,
          search_queries_count: searches.length,
        }
      : undefined,
  };
  if (fileWriteError) {
    result.file_write_error = fileWriteError;
  }
  return result;
}

export function formatDiagnostics({
  model,
  fellBack = false,
  attempts,
  totalAttempts,
  durationMs,
  ttftMs,
}) {
  const parts = [];
  const modelLabel = fellBack ? `${model} (fallback)` : model;
  if (modelLabel) {
    parts.push(`model=${modelLabel}`);
  }
  if (attempts && totalAttempts) {
    parts.push(`attempts=${attempts}/${totalAttempts}`);
  }
  if (typeof durationMs === "number") {
    parts.push(`duration=${(durationMs / 1000).toFixed(1)}s`);
  }
  if (typeof ttftMs === "number") {
    parts.push(`ttft=${(ttftMs / 1000).toFixed(1)}s`);
  }
  return `_diagnostics: ${parts.join(" · ")}_`;
}
