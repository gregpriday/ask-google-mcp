import { DEFAULT_MODEL, MAX_QUESTION_LENGTH, MODEL_ALIASES, VALID_MODELS } from "./config.js";
import { createInvalidParamsError } from "./errors.js";

export const ASK_GOOGLE_TOOL = Object.freeze({
  name: "ask_google",
  description:
    "Grounded Google web research for current/latest info, version checks, and comparisons. Short or long questions; prefer 'current/latest' over hardcoding years.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      question: {
        type: "string",
        description:
          "Grounded web-search query. Can be a short lookup or long-form, multi-part research request. Prefer 'current/latest/as of today' over hardcoding dates unless a specific historical year matters.",
        minLength: 1,
        maxLength: MAX_QUESTION_LENGTH,
        examples: [
          "Find current ECMAScript standard and key new features",
          "React 19 vs 18: breaking changes, migration steps, and notable new APIs",
          "Find current Node.js LTS version and its release date",
          "Check online: is OpenSSL 3.3.2 released yet? Link release notes if so",
        ],
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
        description:
          "Gemini model: 'pro' (default) for deeper synthesis, 'flash' for quick lookups, 'flash-lite' for cheapest/fastest simple facts.",
        enum: VALID_MODELS,
        default: DEFAULT_MODEL,
        examples: VALID_MODELS,
      },
    },
    required: ["question"],
  },
});

export function validateAskGoogleArguments(rawArgs = {}) {
  const question = rawArgs?.question;
  const outputFile = rawArgs?.output_file;
  const model = rawArgs?.model ?? DEFAULT_MODEL;

  if (question === undefined || question === null) {
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

  if (!VALID_MODELS.includes(model)) {
    throw createInvalidParamsError(
      `model must be one of: ${VALID_MODELS.join(", ")}. Got: ${model}`
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

export function extractGroundingData(response) {
  const metadata = response?.candidates?.[0]?.groundingMetadata;
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

export function buildToolText(text, { sources = [], searches = [], fileWriteError } = {}) {
  let fullResponse = text;

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

  return fullResponse;
}
