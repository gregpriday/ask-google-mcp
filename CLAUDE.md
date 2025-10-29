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

1. **Server Initialization** (src/index.js:21-31)
   - Creates MCP Server instance with name/version metadata
   - Declares `tools` capability
   - Connects to StdioServerTransport for JSON-RPC communication

2. **Tool Registration** (src/index.js:34-64)
   - Handles `ListToolsRequestSchema` to expose the `ask_google` tool
   - Tool description is optimized for AI agent invocation with clear trigger phrases
   - Input schema includes validation rules and examples

3. **Request Handling** (src/index.js:67-169)
   - Handles `CallToolRequestSchema` for tool execution
   - **Input validation**: null/undefined check → type check → empty string check → length check (max 10,000 chars)
   - **Gemini integration**: Uses `getGenerativeModel()` with `tools: [{ googleSearch: {} }]` for search grounding
   - **Response formatting**: Extracts grounding metadata (sources, search queries) and appends to response text
   - **Error categorization**: Maps Gemini errors to MCP-friendly error codes (AUTH_ERROR, QUOTA_ERROR, TIMEOUT_ERROR, API_ERROR)

4. **Process Stability** (src/index.js:172-191)
   - Handles unhandled rejections, uncaught exceptions, SIGINT, SIGTERM
   - All failures trigger clean shutdown with error logging to stderr

### Gemini Model Configuration

**Model selection** (src/index.js:36):
- Hard-coded to `models/gemini-flash-latest` (points to Gemini 2.5 Flash)
- Cannot be overridden - optimized for search grounding performance and cost
- Model is configured with `systemInstruction` for AI-optimized output (terse, structured, code-focused)

**Search grounding** (src/index.js:111):
- Enabled via `tools: [{ googleSearch: {} }]` in model config
- Returns `groundingMetadata` with source URLs and search queries performed
- Sources are formatted as markdown links appended to response

### Environment Validation Script

**scripts/check-env.js** provides comprehensive validation:
- Checks `.env` file existence
- Validates `GOOGLE_API_KEY` (not placeholder, minimum length)
- Reports optional vars (`NODE_ENV`) with defaults
- Validates Node.js version against `package.json` engines requirement
- Exits with code 1 on failure (blocks `npm start` via prestart hook)

### Test Architecture

**Unit tests** (test/unit/tool-handler.test.js):
- Mock `MockGenerativeModel` class simulates Gemini API responses
- Extracted `handleAskGoogle()` function mirrors production logic for testability
- Test categories: input validation, successful responses, error handling, edge cases
- 37 total test cases covering all validation rules and error scenarios

**Integration test** (test/test-gemini-mcp.js):
- Tests live Gemini API with real `GOOGLE_API_KEY`
- Validates actual search grounding, source extraction, error handling

## Important Patterns

### Error Handling Strategy

All errors are **categorized by prefix** for MCP client consumption:
- `[AUTH_ERROR]`: API key issues
- `[QUOTA_ERROR]`: Rate limits or quota exceeded
- `[TIMEOUT_ERROR]`: Request timeouts
- `[API_ERROR]`: Generic Gemini API errors

Error detection uses **case-insensitive string matching** on `error.message.toLowerCase()`.

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

Sources and search queries are **optional** (only included if grounding metadata exists).

### Package Distribution

**NPM package** (`@gpriday/ask-google-mcp`):
- Scoped package requires `--access public` for publishing
- Binary: `ask-google-mcp` (defined in package.json bin field)
- Published files: `src/`, `scripts/`, `README.md`, `LICENSE`, `CHANGELOG.md`, `.env.example`
- Use `package-lock.json` is committed for reproducible builds
- CI/CD should use `npm ci` (not `npm install`)

## Model Configuration

The server uses a hard-coded model for consistency:
- Model: `models/gemini-flash-latest` (defined in src/index.js:36)
- Optimized for search grounding with optimal cost/performance
- No environment variable override - ensures consistent behavior across deployments
- If model needs to be changed, edit the `MODEL` constant in src/index.js:36

## Release Process

Use `/release [patch|minor|major]` slash command for automated releases:
- Auto-detects version bump from Conventional Commits if no argument provided
- Validates tests pass, git is clean, NPM authentication
- Updates package.json version
- Creates git commit, tag, publishes to NPM, pushes to origin
- All-or-nothing process (stops on any validation failure)
