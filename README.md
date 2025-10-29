# Ask Google MCP Server

A Model Context Protocol (MCP) server that provides AI-powered Google search using Gemini Flash with search grounding. This server enables Claude Desktop, Claude Code, Cursor, and other MCP clients to perform real-time web searches and get AI-synthesized answers with citations.

## Features

- Real-time Google search via Gemini with search grounding
- Configurable model (defaults to Gemini Flash Latest for cost-efficiency)
- Search grounding with source citations
- Optimized responses for AI agent consumption
- Terse, structured output (bullet points, tables, code blocks)
- Automatic source attribution and search query tracking

## Prerequisites

- Node.js >= 18.0.0
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

Create a `.env` file in your home directory or project root:

```bash
GOOGLE_API_KEY=your_api_key_here
```

You can get a Google API key from [Google AI Studio](https://aistudio.google.com/apikey).

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

Claude Code uses the `claude mcp add` command to configure MCP servers.

### If Installed Globally (Recommended)

```bash
claude mcp add ask-google-mcp
```

When prompted:
- **Command**: `ask-google-mcp`
- **Environment variables**: Add `GOOGLE_API_KEY=your_api_key_here`

### If Running Locally

```bash
claude mcp add ask-google-mcp
```

When prompted:
- **Command**: `node`
- **Arguments**: `/path/to/ask-google-mcp/src/index.js`
- **Environment variables**: Add `GOOGLE_API_KEY=your_api_key_here`

**Verify the server is running:**
```bash
claude mcp list
```

## Integration with Cursor

Cursor configures MCP servers through a JSON configuration file.

### If Installed Globally (Recommended)

1. Open Cursor Settings (⚙️ icon)
2. Select the `MCP` tab
3. Click `Add a new global MCP server`
4. Edit `~/.cursor/mcp.json` (or `.cursor/mcp.json` in your home directory):

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

1. Open Cursor Settings (⚙️ icon)
2. Select the `MCP` tab
3. Click `Add a new global MCP server` or create `.cursor/mcp.json` in your project root
4. Add the following configuration:

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

**Verify the server:** Return to the Cursor MCP settings tab to confirm the server is installed and its tools are available.

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
