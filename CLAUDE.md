# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Model Context Protocol (MCP) server that provides AI-powered Google search using Gemini with search grounding. It enables Claude Desktop and other MCP clients to perform real-time web searches with AI-synthesized answers and citations.

**Key Technologies:**
- MCP SDK (`@modelcontextprotocol/sdk`) for stdio server transport and JSON-RPC 2.0 communication
- Google Generative AI SDK (`@google/generative-ai`) for Gemini API integration
- Node.js native test runner for unit/integration testing
- ES modules (`type: "module"` in package.json)

## Development Commands

### Running the Server
```bash
npm start                    # Start MCP server (runs check-env first)
npm run dev                  # Auto-reload mode with --watch flag
```

### Testing
```bash
npm test                     # Unit tests only (test/unit/**/*.test.js)
npm run test:integration     # Integration test with live Gemini API
npm run test:all             # All tests (unit + integration)
```

**Running a single test file:**
```bash
node --test test/unit/tool-handler.test.js
```

### Environment & Security
```bash
npm run check-env            # Validate .env configuration
npm run security:audit       # Check for vulnerabilities
npm run security:fix         # Auto-fix security issues
npm run security:update      # Update deps and audit
```

## Architecture

### MCP Server Design

The server implements a **single-tool MCP server** following the stdio transport pattern:

1. **Server Initialization** (src/index.js:117-128)
   - Creates MCP Server instance with name/version metadata
   - Declares `tools` capability
   - Connects to StdioServerTransport for JSON-RPC communication

2. **Tool Registration** (src/index.js:131-176)
   - Handles `ListToolsRequestSchema` to expose the `ask_google` tool
   - Tool description is optimized for AI agent invocation with clear trigger phrases
   - Input schema includes validation rules and examples

3. **Request Handling** (src/index.js:179-326)
   - Handles `CallToolRequestSchema` for tool execution
   - **Input validation**: null/undefined check → type check → empty string check → length check (default 64,000 chars / ~16k tokens; configurable via `ASK_GOOGLE_MAX_QUESTION_LENGTH`)
   - **Gemini integration**: Uses `getGenerativeModel()` with `tools: [{ googleSearch: {} }]` for search grounding
   - **Response formatting**: Extracts grounding metadata (sources, search queries), caps at 12 sources and 8 queries, then appends to response text
   - **Error categorization**: Maps Gemini errors to MCP-friendly error codes (AUTH_ERROR, QUOTA_ERROR, TIMEOUT_ERROR, API_ERROR)

4. **Process Stability** (src/index.js:328-360)
   - Handles unhandled rejections, uncaught exceptions, SIGINT, SIGTERM
   - All failures trigger clean shutdown with error logging to stderr

### Gemini Model Configuration

**Model selection**:
- Tool param values: `auto` (default), `pro`, `flash`, `flash-lite`. `auto` is added only when the router is available.
- Model map: `pro` → `gemini-3.1-pro-preview`, `flash` → `gemini-3-flash-preview`, `flash-lite` → `gemini-3.1-flash-lite-preview`
- Model is configured with `systemInstruction` loaded from `src/system-prompt.txt` (cached at startup, date injected per request as ISO-8601)
- System prompt optimized for AI-to-AI communication (terse, direct, no conversational fluff)

### Auto-routing

`src/router.js` runs a tiny Flash-Lite classifier call when `model === "auto"` to pick the downstream tier before the main grounded call:
- Uses `responseMimeType: "application/json"` + strict `responseSchema` enum (`pro | flash | flash-lite`) with `thinkingLevel: MINIMAL`
- System prompt in `src/router-prompt.txt` — kept tight (~400 tokens) and focused on when to pick pro vs flash vs flash-lite
- Output is minimal: `{"model": "..."}` — one field
- 5s timeout by default (`ASK_GOOGLE_ROUTER_TIMEOUT_MS`). Any failure (timeout, parse error, invalid pick, network) collapses to `ROUTER_FALLBACK_MODEL` (default `flash`) without throwing
- Router decision surfaces in `diagnostics.router` and the markdown diagnostics footer (e.g., `model=auto→pro · router=0.4s`)
- Disable with `ASK_GOOGLE_ROUTER_ENABLED=false` (DEFAULT_MODEL then falls back to `pro`)
- Router is only active when its chosen model (default flash-lite) is in `ENABLED_MODELS`; otherwise `ROUTER_AVAILABLE=false` and `"auto"` collapses statically to the fallback without a network call

**Search grounding** (src/index.js:238-242, 250-268):
- Enabled via `tools: [{ googleSearch: {} }]` in model config
- Returns `groundingMetadata` with source URLs and search queries performed
- Sources are deduplicated by URL, filtered for empty URLs, and capped at 12 to prevent bloat
- Search queries are capped at 8
- Sources and queries formatted as markdown and appended to response

### System Prompt Design

**src/system-prompt.txt** defines Gemini's response behavior:
- Loaded once at startup and cached (line 63), only `{{CURRENT_DATE}}` substituted per request (line 236-237)
- Current date injected as ISO-8601: `YYYY-MM-DD (UTC)` for unambiguous parsing
- Optimized for AI-to-AI communication (no pleasantries, conversational filler, or marketing language)
- Enforces information density and machine readability
- Explicit anti-patterns list using "Do not X" per line (not "Do not:" header) for better LLM compliance
- Instructs Gemini not to add its own "Sources" section (server appends authoritative sources list)
- Guides response length, provenance flagging, code inclusion, and formatting choices

### Environment Validation Script

**scripts/check-env.js** provides comprehensive validation:
- Checks `.env` file existence in both project root and home directory (`~/.env`), matching runtime precedence
- Validates `GOOGLE_API_KEY` (not placeholder, minimum length)
- Masks API key in output (shows length, not prefix, to prevent leaks)
- Reports optional vars (`NODE_ENV`) with defaults
- Validates Node.js version against `package.json` engines requirement
- Exits with code 1 on failure (blocks `npm start` via prestart hook)

### Test Architecture

**Unit tests** (test/unit/tool-handler.test.js):
- Mock `MockGenerativeModel` class simulates Gemini API responses
- Extracted `handleAskGoogle()` function mirrors production logic for testability
- Test categories: input validation, successful responses, error handling, edge cases, retry logic, model parameter, auto-routing
- Full coverage of validation rules, error scenarios, retry behavior, and router behavior

**Integration test** (test/test-gemini-mcp.js):
- Tests live Gemini API with real `GOOGLE_API_KEY` from `.env`
- Validates actual search grounding, source extraction, error handling
- Uses MCP protocol handshake (initialize → initialized → tools/list → tools/call)

## Important Patterns

### Error Handling Strategy

All errors are **categorized by prefix** for MCP client consumption:
- `[AUTH_ERROR]`: API key issues (triggers: "api key", "unauthorized", "permission", "401", "403")
- `[QUOTA_ERROR]`: Rate limits or quota exceeded (triggers: "quota", "rate limit", "429", "resource exhausted")
- `[TIMEOUT_ERROR]`: Request timeouts (triggers: "timeout")
- `[API_ERROR]`: Generic Gemini API errors (fallback for all other errors)

Error detection uses **case-insensitive string matching** on `error.message.toLowerCase()`.

**Retry logic** (src/index.js:76-115):
- Retries up to 3 times with exponential backoff (1s, 2s, 4s)
- AUTH_ERROR and QUOTA_ERROR are **not retried** (permanent failures)
- All other errors are retried
- Retry logging shows correct attempt count: "Attempt X/(N+1)"

### Response Format Contract

Responses follow this structure:
```
[AI-generated answer]

---
**Sources:**

1. [Title](URL)
2. [Title](URL)

**Search queries performed:**

1. "query text"
2. "query text"
```

Sources and search queries are **optional** (only included if grounding metadata exists). Sources are capped at 12 and search queries at 8 to prevent bloated responses.

### Package Distribution

**NPM package** (`@gpriday/ask-google-mcp`):
- Scoped package requires `--access public` for publishing
- Binary: `ask-google-mcp` (defined in package.json bin field)
- Published files: `src/`, `scripts/`, `README.md`, `LICENSE`, `CHANGELOG.md`, `.env.example`
- Use `package-lock.json` is committed for reproducible builds
- CI/CD should use `npm ci` (not `npm install`)

## Model Configuration

The server supports three models selectable per-query via the `model` parameter:
- `pro` (default) → `gemini-3.1-pro-preview` — Advanced reasoning with search grounding
- `flash` → `gemini-3-flash-preview` — Fast and cost-effective for simple lookups
- `flash-lite` → `gemini-3.1-flash-lite-preview` — Fastest and cheapest for simple factual queries
- Model map is defined in `src/index.js` in the `modelMap` object

## Release Process

Use `/release [patch|minor|major]` slash command for automated releases:
- Auto-detects version bump from Conventional Commits if no argument provided
- Validates tests pass, git is clean, NPM authentication
- Updates package.json version
- Creates git commit, tag, publishes to NPM, pushes to origin
- All-or-nothing process (stops on any validation failure)
