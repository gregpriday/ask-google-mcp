import {
  DEFAULT_MODEL,
  ENABLED_MODELS,
  MAX_QUESTION_LENGTH,
  MODEL_ALIASES,
  MODEL_PARAM_VALUES,
  ROUTER_AVAILABLE,
} from "./config.js";
import { createInvalidParamsError } from "./errors.js";
import { wrapUntrusted } from "./sanitize.js";

export const ASK_GOOGLE_TOOL = Object.freeze({
  name: "ask_google",
  description:
    "Gemini with Google Search grounding. Use for current/latest facts that post-date your training: versions, releases, API changes, changelogs, breaking news, on-demand web research. Do not use for stable syntax or knowledge already in your training. Short lookups or multi-paragraph briefs both work.",
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
      model: {
        type: "string",
        description: ROUTER_AVAILABLE
          ? `Google model. 'auto' (default, recommended) picks the right tier automatically. Override with 'pro', 'flash', or 'flash-lite' only if you need a specific one.`
          : `Google model. Default: '${DEFAULT_MODEL}'.`,
        enum: MODEL_PARAM_VALUES,
        default: DEFAULT_MODEL,
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      answer: { type: "string" },
      answer_with_citations: { type: "string" },
      grounding_status: {
        type: "string",
        enum: ["grounded", "sources_only", "no_sources", "not_attempted", "unavailable"],
        description:
          "How thoroughly the answer is grounded. 'grounded' = sources + per-claim supports. 'sources_only' = pages retrieved but no per-claim mapping. 'no_sources' = search ran but returned nothing — answer is from training data, treat with high skepticism. 'not_attempted' / 'unavailable' = even worse.",
      },
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
      supports: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            start_index: { type: "integer" },
            end_index: { type: "integer" },
            text: { type: "string" },
            source_indices: { type: "array", items: { type: "integer" } },
          },
          required: ["end_index", "source_indices"],
        },
      },
      diagnostics: {
        type: "object",
        additionalProperties: true,
        properties: {
          model: { type: "string" },
          requested_model: { type: "string" },
          fell_back: { type: "boolean" },
          attempts: { type: "integer" },
          total_attempts: { type: "integer" },
          duration_ms: { type: "integer" },
          ttft_ms: { type: ["integer", "null"] },
          search_queries_count: { type: "integer" },
          router: {
            type: "object",
            additionalProperties: true,
            properties: {
              picked_model: { type: "string" },
              duration_ms: { type: "integer" },
              used_fallback: { type: "boolean" },
              reason: { type: "string" },
              snapped_from: { type: "string" },
            },
          },
        },
      },
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

  if (!MODEL_PARAM_VALUES.includes(model)) {
    throw createInvalidParamsError(
      `model must be one of: ${MODEL_PARAM_VALUES.join(", ")}. Got: ${model}`
    );
  }

  return {
    question,
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
  const rawChunks = metadata?.groundingChunks || [];
  const rawSources = rawChunks.map((chunk) => ({
    title: chunk.web?.title || "Unknown",
    url: chunk.web?.uri || "",
    domain: chunk.web?.domain || "",
  }));

  // Build deduped sources (capped) and a parallel map from raw chunk index → 1-based display
  // index. groundingSupports references chunks by their original index, so we need this map to
  // splice citation markers that line up with the displayed Sources list.
  const seenUrls = new Map(); // url -> displayIndex (1-based)
  const sources = [];
  const rawIndexToDisplayIndex = new Map();
  for (let i = 0; i < rawSources.length; i += 1) {
    const source = rawSources[i];
    if (!source.url) continue;
    if (seenUrls.has(source.url)) {
      rawIndexToDisplayIndex.set(i, seenUrls.get(source.url));
      continue;
    }
    if (sources.length >= 12) continue;
    sources.push(source);
    const displayIndex = sources.length; // 1-based
    seenUrls.set(source.url, displayIndex);
    rawIndexToDisplayIndex.set(i, displayIndex);
  }

  const rawSupports = metadata?.groundingSupports || [];
  const supports = rawSupports
    .map((s) => {
      const endIndex = s?.segment?.endIndex;
      const chunkIdx = s?.groundingChunkIndices || [];
      if (typeof endIndex !== "number" || chunkIdx.length === 0) return null;
      const seenDisplay = new Set();
      const displayIndices = [];
      for (const i of chunkIdx) {
        const d = rawIndexToDisplayIndex.get(i);
        if (d !== undefined && !seenDisplay.has(d)) {
          seenDisplay.add(d);
          displayIndices.push(d);
        }
      }
      if (displayIndices.length === 0) return null;
      return {
        startIndex: s.segment.startIndex ?? 0,
        endIndex,
        text: s.segment.text || "",
        sourceIndices: displayIndices,
      };
    })
    .filter(Boolean);

  const searches = (metadata?.webSearchQueries || []).slice(0, 8);
  const groundingStatus = computeGroundingStatus(metadata);
  return { sources, searches, supports, groundingStatus };
}

// Distinguish how thoroughly the model actually grounded its answer. Callers (and humans)
// need this signal to decide whether to trust the response. The model often runs searches and
// then answers from training data anyway — silently — and that's the worst-case failure mode.
export function computeGroundingStatus(metadata) {
  if (!metadata) return "unavailable";
  const queries = metadata.webSearchQueries?.length || 0;
  const chunks = metadata.groundingChunks?.length || 0;
  const supports = metadata.groundingSupports?.length || 0;
  if (queries === 0) return "not_attempted";
  if (chunks === 0) return "no_sources";
  if (supports === 0) return "sources_only";
  return "grounded";
}

const GROUNDING_WARNINGS = {
  unavailable:
    "⚠ NO GROUNDING METADATA. The model did not return any grounding signal — the answer below is unverified and likely from training data alone. Treat with skepticism.",
  not_attempted:
    "⚠ NO SEARCH PERFORMED. The model did not run any web searches for this query. The answer below is from training data only and may be out of date or fabricated.",
  no_sources:
    "⚠ ZERO GROUNDING SOURCES. The model ran web searches but returned no source pages — the answer below was synthesized from training data, not retrieved evidence. Specific facts (names, dates, numbers) are at high risk of being hallucinated.",
  sources_only:
    "⚠ SOURCES BUT NO CLAIM-LEVEL GROUNDING. The model retrieved pages but did not map specific claims to specific sources. Treat the answer as a paraphrase rather than verified fact-by-fact.",
};

export function groundingWarning(status) {
  return GROUNDING_WARNINGS[status] || null;
}

// Splice inline `[N](url)` citation markers into the answer text using groundingSupports.
// Per the official @google/genai docs, the algorithm is: sort supports by endIndex DESC, then
// splice citation strings at each endIndex (descending order avoids index drift as we mutate
// the string). This is the only reliable way to surface "which sentence came from which source"
// — the model's own prose rarely cites consistently even when instructed to.
export function applyInlineCitations(text, supports, sources) {
  if (typeof text !== "string" || text.length === 0) return text;
  if (!Array.isArray(supports) || supports.length === 0) return text;
  if (!Array.isArray(sources) || sources.length === 0) return text;

  const sorted = [...supports].sort((a, b) => b.endIndex - a.endIndex);
  let out = text;
  for (const s of sorted) {
    const links = s.sourceIndices
      .map((i) => {
        const url = sources[i - 1]?.url;
        return url ? `[${i}](${url})` : null;
      })
      .filter(Boolean);
    if (links.length === 0) continue;
    const marker = links.join("");
    const safeEnd = Math.min(s.endIndex, out.length);
    out = out.slice(0, safeEnd) + marker + out.slice(safeEnd);
  }
  return out;
}

export function buildToolText(
  text,
  { sources = [], searches = [], supports = [], groundingStatus = "grounded", diagnostics } = {}
) {
  // Splice grounding-supports citations BEFORE wrapping/sanitizing so the offsets line up with
  // the model's original text. The wrapper adds a known prefix; sanitize doesn't change indices.
  const cited = applyInlineCitations(text, supports, sources);
  const warning = groundingWarning(groundingStatus);
  const body = warning ? `${warning}\n\n${cited}` : cited;
  let fullResponse = wrapUntrusted(body);

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

  if (diagnostics) {
    fullResponse += `\n\n---\n${formatDiagnostics(diagnostics)}`;
  }

  return fullResponse;
}

export function buildStructuredContent(
  text,
  { sources = [], searches = [], supports = [], groundingStatus = "grounded", diagnostics } = {}
) {
  return {
    answer: text,
    answer_with_citations: applyInlineCitations(text, supports, sources),
    grounding_status: groundingStatus,
    sources,
    search_queries: [...searches],
    supports: supports.map((s) => ({
      start_index: s.startIndex,
      end_index: s.endIndex,
      text: s.text,
      source_indices: s.sourceIndices,
    })),
    diagnostics: diagnostics
      ? {
          model: diagnostics.model,
          requested_model: diagnostics.requestedModel,
          fell_back: Boolean(diagnostics.fellBack),
          attempts: diagnostics.attempts,
          total_attempts: diagnostics.totalAttempts,
          duration_ms: diagnostics.durationMs,
          ttft_ms: diagnostics.ttftMs ?? null,
          search_queries_count: searches.length,
          sources_count: sources.length,
          supports_count: supports.length,
          grounding_status: groundingStatus,
          ...(diagnostics.router
            ? {
                router: {
                  picked_model: diagnostics.router.pickedModel,
                  duration_ms: diagnostics.router.durationMs,
                  used_fallback: Boolean(diagnostics.router.usedFallback),
                  ...(diagnostics.router.reason ? { reason: diagnostics.router.reason } : {}),
                  ...(diagnostics.router.snappedFrom
                    ? { snapped_from: diagnostics.router.snappedFrom }
                    : {}),
                },
              }
            : {}),
        }
      : undefined,
  };
}

export function formatDiagnostics({
  model,
  requestedModel,
  fellBack = false,
  attempts,
  totalAttempts,
  durationMs,
  ttftMs,
  groundingStatus,
  router,
}) {
  const parts = [];
  const modelLabel = fellBack ? `${model} (fallback)` : model;
  if (modelLabel) {
    // Surface routing provenance in the footer: "auto→pro" tells the caller both what they asked
    // for and what the router (or explicit pick) resolved to, without adding noise for the
    // common case where they pinned a specific tier.
    if (requestedModel && requestedModel !== model && requestedModel === "auto") {
      parts.push(`model=auto→${modelLabel}`);
    } else {
      parts.push(`model=${modelLabel}`);
    }
  }
  if (router) {
    const routerBits = [`${(router.durationMs / 1000).toFixed(1)}s`];
    if (router.usedFallback) routerBits.push("fallback");
    if (router.snappedFrom) routerBits.push(`snapped<-${router.snappedFrom}`);
    parts.push(`router=${routerBits.join("/")}`);
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
  if (groundingStatus) {
    parts.push(`grounding=${groundingStatus}`);
  }
  return `_diagnostics: ${parts.join(" · ")}_`;
}
