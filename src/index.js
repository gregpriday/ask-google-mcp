#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

// Initialize Gemini AI client
const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) {
  throw new Error("GOOGLE_API_KEY environment variable is required");
}

const genAI = new GoogleGenerativeAI(apiKey);
const MODEL = "gemini-2.0-flash-exp";

// Create MCP server
const server = new Server(
  {
    name: "gemini-search",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "ask_google",
        description: "Ask Google a question and get an AI-generated answer with search grounding. The model will search the internet for current information and provide a comprehensive response with sources.",
        inputSchema: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The question to ask Google (will be answered using Gemini 2.5 Pro with search grounding)",
            },
          },
          required: ["question"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "ask_google") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const question = request.params.arguments?.question;
  if (!question || typeof question !== "string") {
    throw new Error("Question is required and must be a string");
  }

  try {
    // System prompt optimized for AI agent consumption
    const systemPrompt = `You are answering questions for an AI agent building developer skills and documentation.

Output requirements:
- Be terse and structured (use bullet points, tables, code blocks)
- Focus on: specific syntax, decision rules, anti-patterns, breaking changes, version numbers
- Avoid: marketing language, verbose explanations, unnecessary context
- Include: exact commands, configuration snippets, code examples
- Prioritize: patterns AI can apply directly to code generation
- Format: Problem → Solution → Code Example (when applicable)
- Use tables for comparisons (e.g., "Feature | Old Version | New Version")
- List common mistakes with ❌ wrong code and ✅ correct code side-by-side

Structure responses as actionable reference material, not tutorials.`;

    // Get the model with search grounding
    const model = genAI.getGenerativeModel({
      model: MODEL,
      systemInstruction: systemPrompt,
      tools: [{ googleSearch: {} }],
    });

    // Generate response with search grounding
    const result = await model.generateContent(question);
    const response = result.response;

    // Extract grounding metadata (sources and searches performed)
    const metadata = response.candidates?.[0]?.groundingMetadata;
    const sources = metadata?.groundingChunks?.map(chunk => ({
      title: chunk.web?.title || "Unknown",
      url: chunk.web?.uri || "",
      domain: chunk.web?.domain || "",
    })) || [];

    const searches = metadata?.webSearchQueries || [];

    // Build comprehensive response
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
    // Enhanced error handling
    const errorMessage = error.message || "Generation failed";
    throw new Error(`Gemini API error: ${errorMessage}`);
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Gemini MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
