# Ask Google MCP Server

`ask-google-mcp` is a stdio MCP server that exposes a single tool, `ask_google`.

That tool sends a question to Gemini with Google Search grounding enabled, then returns:

- a synthesized answer
- appended source links
- appended search queries Gemini performed

This is for agent workflows that need current web information inside an MCP client such as Claude Code.

## What It Does

`ask_google` is useful when the agent needs information that should not be answered from stale training data alone, for example:

- latest versions, releases, and changelogs
- current docs, standards, or API changes
- comparisons between current products or libraries
- recent announcements or status checks
- short web research tasks with citations

The server is intentionally narrow:

- one MCP tool: `ask_google`
- stdio transport only
- no web UI
- no HTTP server

## Recommended Setup: Claude Code User Scope

I checked the local Claude Code CLI help.

`claude mcp --help` shows that `add` supports scopes `local`, `user`, and `project`, and `claude mcp add --help` shows the default scope is `local`.

If you want this available across all projects, use `--scope user`.

### Option 1: Install from npm globally

```bash
npm install -g @gpriday/ask-google-mcp
```

Then add it to Claude Code at user scope and set the API key directly in the MCP config:

```bash
claude mcp add --scope user -e GOOGLE_API_KEY=your_api_key_here ask-google -- ask-google-mcp
```

Verify it:

```bash
claude mcp get ask-google
claude mcp list
```

### Option 2: Use a local checkout

This is better for development, not for normal usage.

```bash
git clone https://github.com/gpriday/ask-google-mcp.git
cd ask-google-mcp
npm install
```

Then register that checkout with Claude Code:

```bash
claude mcp add --scope user -e GOOGLE_API_KEY=your_api_key_here ask-google -- node /absolute/path/to/ask-google-mcp/src/index.js
```

## Requirements

- Node.js `>=20`
- A Google AI Studio API key with Gemini access

Get an API key here:

- https://aistudio.google.com/apikey

## How Configuration Actually Works

The server loads environment variables in this order:

1. `process.cwd()/.env`
2. `~/.env`
3. existing process environment variables

That means:

- it does read `~/.env`
- it does not read a fixed repository root unless the server process is started from that directory
- for Claude Code, passing the API key with `claude mcp add -e GOOGLE_API_KEY=...` is the clearest and most reliable setup

Minimum required variable for live tool calls:

```bash
GOOGLE_API_KEY=your_api_key_here
```

Optional variables:

```bash
ASK_GOOGLE_TIMEOUT_MS=300000
ASK_GOOGLE_ALLOW_FILE_OUTPUT=false
ASK_GOOGLE_OUTPUT_DIR=.
ASK_GOOGLE_MAX_RETRIES=3
ASK_GOOGLE_INITIAL_RETRY_DELAY_MS=1000

# Optional model alias overrides
# ASK_GOOGLE_MODEL_PRO=gemini-3.1-pro-preview
# ASK_GOOGLE_MODEL_FLASH=gemini-3-flash-preview
# ASK_GOOGLE_MODEL_FLASH_LITE=gemini-3.1-flash-lite-preview
```

## Runtime Behavior

- The server starts even if `GOOGLE_API_KEY` is missing.
- MCP clients can still initialize and list tools without the key.
- The `ask_google` tool itself returns an `[AUTH_ERROR]` if called without a key.
- Requests time out after `ASK_GOOGLE_TIMEOUT_MS` milliseconds unless you override it.
- Retries are enabled for retryable upstream failures.

## Tool Reference

### Tool name

`ask_google`

### Inputs

- `question` - required string, 1 to 10,000 characters
- `model` - optional: `pro`, `flash`, or `flash-lite`
- `output_file` - optional file path for saving the final response

### Model aliases

- `pro` -> `gemini-3.1-pro-preview`
- `flash` -> `gemini-3-flash-preview`
- `flash-lite` -> `gemini-3.1-flash-lite-preview`

Those defaults can be overridden with environment variables if Google renames preview models.

### `output_file` safety rules

`output_file` is intentionally locked down.

- It is disabled by default.
- It only works when `ASK_GOOGLE_ALLOW_FILE_OUTPUT=true`.
- Writes are restricted to `ASK_GOOGLE_OUTPUT_DIR`.
- Relative paths resolve under that base directory.
- Absolute paths are only allowed if they still resolve inside that base directory.

## Example Tool Calls

### Basic current-information query

```json
{
  "name": "ask_google",
  "arguments": {
    "question": "Find the current Node.js LTS version and its release date"
  }
}
```

### Faster lookup with `flash`

```json
{
  "name": "ask_google",
  "arguments": {
    "question": "What is the latest stable TypeScript release?",
    "model": "flash"
  }
}
```

### Research-style comparison

```json
{
  "name": "ask_google",
  "arguments": {
    "question": "React 19 vs React 18: current migration risks, breaking changes, and official upgrade guidance"
  }
}
```

### Save output to a file

This only works if file output is enabled in the server environment.

```json
{
  "name": "ask_google",
  "arguments": {
    "question": "Summarize the latest ECMAScript standard and notable additions",
    "output_file": "research/ecmascript.md"
  }
}
```

## What The Tool Returns

The tool returns text content that includes:

- Gemini's answer
- a `Sources` section appended by the server
- a `Search queries performed` section appended by the server when available

## CLI Usage

If you installed the package globally:

```bash
ask-google-mcp
```

If you are running from a local checkout:

```bash
npm start
```

CLI flags:

```bash
ask-google-mcp --help
ask-google-mcp --version
```

## Environment Validation

For local development, validate configuration with:

```bash
npm run check-env
```

That script checks:

- whether a local `.env` or `~/.env` exists
- whether `GOOGLE_API_KEY` looks present and non-placeholder
- Node.js version compatibility
- optional runtime settings like timeout and file-output flags

## Claude Desktop

Claude Code is the primary recommended workflow, but Claude Desktop can also run the server.

Global install example:

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

Local checkout example:

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

## Development

Project structure:

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

- `npm start` - start the MCP server
- `npm test` - run unit tests
- `npm run test:integration` - run live integration tests when enabled
- `npm run test:all` - run both suites
- `npm run dev` - run with `node --watch`
- `npm run check-env` - validate environment config

Live integration tests only run when both are set:

```bash
RUN_LIVE_TESTS=1
GOOGLE_API_KEY=your_api_key_here
```

## Error Categories

Tool failures are surfaced as MCP errors with categorized messages:

- `[AUTH_ERROR]` - missing or invalid API key
- `[QUOTA_ERROR]` - quota or rate limit exceeded
- `[TIMEOUT_ERROR]` - request timed out
- `[API_ERROR]` - other Gemini/API failures
- `[CONFIG_ERROR]` - disabled or unsafe file-output configuration

## License

MIT
