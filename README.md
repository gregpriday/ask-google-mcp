# Ask Google MCP Server

A Model Context Protocol (MCP) server that provides AI-powered Google search using Gemini Flash with search grounding. This server enables Claude Desktop, Claude Code, and other MCP clients to perform real-time web searches and get AI-synthesized answers with citations.

## Features

- Real-time Google search via Gemini with search grounding
- Configurable model (defaults to Gemini Flash Latest for cost-efficiency)
- Search grounding with source citations
- Optimized responses for AI agent consumption
- Terse, structured output (bullet points, tables, code blocks)
- Automatic source attribution and search query tracking

## Prerequisites

- Node.js >= 20.0.0 (Node.js 18.x reached End-of-Life April 2025)
- Google API Key with Gemini API access

## Installation

### Option 1: NPM Global Install (Recommended)

Install globally from NPM:

```bash
npm install -g @gpriday/ask-google-mcp
```

The `ask-google-mcp` command will be available globally.

### Option 2: Local Development Install

For development or local testing:

```bash
# Clone the repository
git clone https://github.com/gpriday/ask-google-mcp.git
cd ask-google-mcp

# Install dependencies
npm install
```

### Configuration

Create a `.env` file in your project root or home directory (`~/.env`):

```bash
GOOGLE_API_KEY=your_api_key_here
```

You can get a Google API key from [Google AI Studio](https://aistudio.google.com/apikey).

**For local development**, validate your configuration with:
```bash
npm run check-env
```

The server will automatically load `.env` from:
1. Current working directory (`.env`)
2. Home directory (`~/.env`) as fallback
3. Or use environment variables directly

## Usage

### Run the MCP Server

**If installed globally:**
```bash
ask-google-mcp
```

**If running locally:**
```bash
npm start
```

The server runs on stdio and communicates via JSON-RPC 2.0.

**Note:** When running globally, the server will look for `.env` in the current directory or use environment variables directly.

### Test the Server

**Unit tests**
```bash
npm test
```

**Integration test**
```bash
npm run test:integration
```

**All tests**
```bash
npm run test:all
```

### Available Tools

#### ask_google

Grounded Google web research (Gemini).

**Use when:** user says "check online", "ask google", "research"; asks for **latest standards/versions**, compares releases, or requests **up-to-date** facts.

**Input:**
- `question` (string, required) — the research question (1-10,000 characters)

**Output:**
- Concise answer with citations
- Source URLs
- Search queries performed

**Examples:**
```json
{
  "name": "ask_google",
  "arguments": {
    "question": "Latest ECMAScript standard and new features"
  }
}
```

```json
{
  "name": "ask_google",
  "arguments": {
    "question": "React 19: what's new vs 18?"
  }
}
```

```json
{
  "name": "ask_google",
  "arguments": {
    "question": "Check online: is OpenSSL 3.3.2 out yet?"
  }
}
```

## Integration with Claude Desktop

Add this server to your Claude Desktop configuration.

### If Installed Globally (Recommended)

#### macOS
Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

#### Windows
Edit `%APPDATA%\Claude\claude_desktop_config.json`:

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

#### Linux
Edit `~/.config/Claude/claude_desktop_config.json`:

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

### If Running Locally

#### macOS
Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ask-google": {
      "command": "node",
      "args": ["/path/to/ask-google-mcp/src/index.js"],
      "env": {
        "GOOGLE_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

#### Windows
Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ask-google": {
      "command": "node",
      "args": ["C:\\path\\to\\ask-google-mcp\\src\\index.js"],
      "env": {
        "GOOGLE_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

#### Linux
Edit `~/.config/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ask-google": {
      "command": "node",
      "args": ["/path/to/ask-google-mcp/src/index.js"],
      "env": {
        "GOOGLE_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

**After updating the configuration, restart Claude Desktop.**

## Integration with Claude Code

Add the MCP server using the `claude mcp add` command.

### If Installed Globally (Recommended)

**For current project only:**
```bash
claude mcp add --scope project ask-google -e GOOGLE_API_KEY=your_api_key_here -- ask-google-mcp
```

**For your user (available in all projects):**
```bash
claude mcp add --scope user ask-google -e GOOGLE_API_KEY=your_api_key_here -- ask-google-mcp
```

**For local directory:**
```bash
claude mcp add --scope local ask-google -e GOOGLE_API_KEY=your_api_key_here -- ask-google-mcp
```

### If Running Locally

**For current project:**
```bash
claude mcp add --scope project ask-google -e GOOGLE_API_KEY=your_api_key_here -- node /path/to/ask-google-mcp/src/index.js
```

**Verify the server is running:**
```bash
claude mcp list
```

## Integration with OpenAI Codex

**Note:** This refers to the **OpenAI Codex CLI** (released April 2025), a terminal-based coding agent with MCP support. This is different from the deprecated "OpenAI Codex" model from 2021-2023.

Add the MCP server using the `codex mcp add` command or by editing the `~/.codex/config.toml` file.

### Using CLI (Recommended)

**If installed globally:**
```bash
codex mcp add ask-google --env GOOGLE_API_KEY=your_api_key_here -- ask-google-mcp
```

**If running locally:**
```bash
codex mcp add ask-google --env GOOGLE_API_KEY=your_api_key_here -- node /path/to/ask-google-mcp/src/index.js
```

**Verify the server:**
```bash
codex mcp list
```

### Manual Configuration

Edit `~/.codex/config.toml`:

**If installed globally:**
```toml
[mcp.ask-google]
command = "ask-google-mcp"
env = ["GOOGLE_API_KEY=your_api_key_here"]
```

**If running locally:**
```toml
[mcp.ask-google]
command = "node"
args = ["/path/to/ask-google-mcp/src/index.js"]
env = ["GOOGLE_API_KEY=your_api_key_here"]
```

**Note:** Restart Codex CLI or IDE extension after editing `config.toml` for changes to take effect.

## Response Format

The server provides structured, terse responses optimized for AI consumption:

- Bullet points for lists
- Tables for comparisons
- Code blocks for examples
- Exact commands and configuration snippets
- Side-by-side wrong/correct code examples
- Version numbers and breaking changes
- Source citations with URLs
- Search queries performed

## Development

### Dependency Management

This project follows MCP best practices for Node.js dependency management:

- **Semver Ranges**: Dependencies use caret (`^`) ranges in `package.json` to automatically receive patch and minor security updates
- **Lockfile**: `package-lock.json` is committed to ensure reproducible builds
- **CI/CD**: Use `npm ci` (not `npm install`) to enforce lockfile versions in production
- **Security**: Run `npm run security:audit` regularly and schedule `npm run security:update` for patch updates

### Project Structure

```
ask-google/
├── src/
│   └── index.js               # Main MCP server
├── scripts/
│   └── check-env.js           # Environment validation
├── test/
│   ├── unit/
│   │   └── tool-handler.test.js  # Unit tests
│   └── test-gemini-mcp.js     # Integration tests
├── package.json
├── package-lock.json          # Committed for reproducibility
├── .env                       # API key (git-ignored)
├── .env.example               # API key template
├── .gitignore
├── LICENSE
└── README.md
```

### Scripts

**Development:**
- `npm start` - Start the MCP server (auto-runs environment validation)
- `npm test` - Run unit tests
- `npm run test:integration` - Run integration tests
- `npm run test:all` - Run all tests (unit + integration)
- `npm run dev` - Run server with auto-reload (Node 18+ with --watch)

**Environment & Security:**
- `npm run check-env` - Validate environment configuration
- `npm run security:audit` - Check for security vulnerabilities
- `npm run security:fix` - Auto-fix security issues (within semver ranges)
- `npm run security:update` - Update dependencies and audit for vulnerabilities

## Environment Variables

- `GOOGLE_API_KEY` (required) - Your Google API key for Gemini API access
- `GEMINI_MODEL` (optional) - Gemini model to use (default: `models/gemini-flash-latest`)

### Model Selection

Set `GEMINI_MODEL` in your `.env` file or environment variables to override the default model:

```bash
# .env
GOOGLE_API_KEY=your_api_key_here
GEMINI_MODEL=models/gemini-flash-latest
```

Available models:
- `models/gemini-flash-latest` (default, cost-efficient, points to Gemini 2.5 Flash)
- `models/gemini-2.5-flash` (stable Gemini 2.5 Flash version)
- `models/gemini-2.5-pro-latest` (more powerful, higher cost)

## Error Handling

The server provides categorized error handling:

- **Input Validation**: Questions are validated for presence, type, length (max 10,000 chars)
- **[AUTH_ERROR]**: Missing or invalid API keys
- **[QUOTA_ERROR]**: API quota or rate limit exceeded
- **[TIMEOUT_ERROR]**: Request timeout errors
- **[API_ERROR]**: General API errors
- **Process Stability**: Unhandled rejections and exceptions trigger clean shutdown

## License

MIT

## Contributing

Contributions welcome! Please open an issue or PR.

## Support

For issues or questions:
1. Check the [MCP documentation](https://modelcontextprotocol.io)
2. Review [Google Gemini API docs](https://ai.google.dev/docs)
3. Open an issue in this repository
