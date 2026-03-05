# Ask Google MCP Server

A small MCP server that exposes one tool, `ask_google`, backed by Gemini search grounding.

It is designed for agent workflows that need current web information, version checks, release comparisons, and short research answers with citations.

## Highlights

- Starts cleanly even if `GOOGLE_API_KEY` is not set, so MCP clients can still initialize and list tools
- One grounded research tool with explicit model selection
- Configurable request timeout and retry behavior
- Optional `output_file` support, disabled by default and confined to a safe base directory
- Source and search-query metadata appended to responses
- Unit tests against production modules, plus a gated live integration test

## Requirements

- Node.js `>=20`
- A Google AI Studio API key for live tool calls

## Install

### Global install

```bash
npm install -g @gpriday/ask-google-mcp
```

### Local development

```bash
git clone https://github.com/gpriday/ask-google-mcp.git
cd ask-google-mcp
npm install
```

## Configuration

The server loads environment variables from:

1. `./.env`
2. `~/.env`
3. The process environment

Minimum configuration:

```bash
GOOGLE_API_KEY=your_api_key_here
```

Optional runtime settings:

```bash
ASK_GOOGLE_TIMEOUT_MS=30000
ASK_GOOGLE_ALLOW_FILE_OUTPUT=false
ASK_GOOGLE_OUTPUT_DIR=.
# ASK_GOOGLE_MODEL_PRO=gemini-3.1-pro-preview
# ASK_GOOGLE_MODEL_FLASH=gemini-3-flash-preview
# ASK_GOOGLE_MODEL_FLASH_LITE=gemini-3.1-flash-lite-preview
```

Validate your setup locally:

```bash
npm run check-env
```

## Usage

### Start the server

Global install:

```bash
ask-google-mcp
```

Local checkout:

```bash
npm start
```

The server communicates over stdio using JSON-RPC 2.0.

If `GOOGLE_API_KEY` is missing, the server still starts and lists tools, but `ask_google` calls return an `[AUTH_ERROR]`.

### Tool: `ask_google`

Use it when the caller needs current information from the web.

Inputs:

- `question` - required string, `1..10000` characters
- `model` - optional: `pro` (default), `flash`, or `flash-lite`
- `output_file` - optional path to save the response; only works when `ASK_GOOGLE_ALLOW_FILE_OUTPUT=true`

`output_file` safety rules:

- Writes are disabled by default
- Relative paths resolve under `ASK_GOOGLE_OUTPUT_DIR` or the current working directory
- Absolute paths are allowed only if they still resolve inside the configured base directory

Example tool call:

```json
{
  "name": "ask_google",
  "arguments": {
    "question": "Find current Node.js LTS version and release date",
    "model": "flash"
  }
}
```

Example with file output enabled:

```json
{
  "name": "ask_google",
  "arguments": {
    "question": "React 19 vs 18: breaking changes and migration steps",
    "output_file": "./research/react19.md"
  }
}
```

## Client setup

### Claude Desktop

```json
{
  "mcpServers": {
    "ask-google": {
      "command": "ask-google-mcp",
      "env": {
        "GOOGLE_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

For a local checkout, replace the command with:

```json
{
  "mcpServers": {
    "ask-google": {
      "command": "node",
      "args": ["/absolute/path/to/ask-google-mcp/src/index.js"],
      "env": {
        "GOOGLE_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### Claude Code

Global install:

```bash
claude mcp add --scope user ask-google -e GOOGLE_API_KEY=your_api_key_here -- ask-google-mcp
```

Local checkout:

```bash
claude mcp add --scope project ask-google -e GOOGLE_API_KEY=your_api_key_here -- node /absolute/path/to/ask-google-mcp/src/index.js
```

### Codex CLI

Global install:

```bash
codex mcp add ask-google --env GOOGLE_API_KEY=your_api_key_here -- ask-google-mcp
```

Local checkout:

```bash
codex mcp add ask-google --env GOOGLE_API_KEY=your_api_key_here -- node /absolute/path/to/ask-google-mcp/src/index.js
```

## Development

Project layout:

```text
src/
  ask-google.js
  config.js
  errors.js
  file-output.js
  index.js
  prompt.js
  retry.js
  server.js
  system-prompt.txt
scripts/
  check-env.js
test/
  integration/
  support/
  unit/
```

Scripts:

- `npm start` - run the MCP server
- `npm test` - run unit tests
- `npm run test:integration` - run live integration tests when `RUN_LIVE_TESTS=1`
- `npm run test:all` - run both suites
- `npm run dev` - run with `node --watch`
- `npm run check-env` - validate local configuration

Live integration tests are skipped unless both of these are set:

```bash
RUN_LIVE_TESTS=1
GOOGLE_API_KEY=your_api_key_here
```

## CI

GitHub Actions runs:

- `npm ci`
- `npm test`
- `node src/index.js --help`
- `node src/index.js --version`

## Error categories

Tool failures are returned as MCP errors with categorized messages:

- `[AUTH_ERROR]` - missing or invalid API key
- `[QUOTA_ERROR]` - quota or rate limit exhaustion
- `[TIMEOUT_ERROR]` - request timed out
- `[API_ERROR]` - other Gemini failures
- `[CONFIG_ERROR]` - unsafe or disabled file output configuration

## License

MIT
