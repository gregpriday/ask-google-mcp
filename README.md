# Ask Google MCP Server

A Model Context Protocol (MCP) server that provides AI-powered Google search using Gemini 2.5 Pro with search grounding. This server enables Claude Desktop and other MCP clients to perform real-time web searches and get AI-synthesized answers with citations.

## Features

- Real-time Google search via Gemini 2.5 Pro
- Search grounding with source citations
- Optimized responses for AI agent consumption
- Terse, structured output (bullet points, tables, code blocks)
- Automatic source attribution and search query tracking

## Prerequisites

- Node.js >= 18.0.0
- Google API Key with Gemini API access

## Installation

### 1. Clone or Download

```bash
cd /path/to/ask-google
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure API Key

Create a `.env` file in the project root:

```bash
GOOGLE_API_KEY=your_api_key_here
```

You can get a Google API key from [Google AI Studio](https://aistudio.google.com/apikey).

## Usage

### Run the MCP Server

```bash
npm start
```

The server runs on stdio and communicates via JSON-RPC 2.0.

### Test the Server

```bash
npm test
```

This runs integration tests that validate the server functionality.

### Available Tools

#### ask_google

Ask Google a question and get an AI-generated answer with search grounding.

**Parameters:**
- `question` (string, required): The question to ask Google

**Response:**
- AI-synthesized answer based on current web search results
- Source citations with URLs
- List of search queries performed

**Example:**
```json
{
  "name": "ask_google",
  "arguments": {
    "question": "What are the latest features in React 19?"
  }
}
```

## Integration with Claude Desktop

Add this server to your Claude Desktop configuration:

### macOS

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ask-google": {
      "command": "node",
      "args": ["/path/to/ask-google/src/index.js"],
      "env": {
        "GOOGLE_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### Windows

Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ask-google": {
      "command": "node",
      "args": ["C:\\path\\to\\ask-google\\src\\index.js"],
      "env": {
        "GOOGLE_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### Linux

Edit `~/.config/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ask-google": {
      "command": "node",
      "args": ["/path/to/ask-google/src/index.js"],
      "env": {
        "GOOGLE_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

After updating the configuration, restart Claude Desktop.

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

### Project Structure

```
ask-google/
├── src/
│   └── index.js          # Main MCP server
├── test/
│   └── test-gemini-mcp.js # Integration tests
├── package.json
├── .env                   # API key (git-ignored)
├── .env.example           # API key template
├── .gitignore
├── LICENSE
└── README.md
```

### Scripts

- `npm start` - Start the MCP server
- `npm test` - Run integration tests
- `npm run dev` - Run server with auto-reload (Node 18+ with --watch)

## Environment Variables

- `GOOGLE_API_KEY` (required) - Your Google API key for Gemini API access

## Error Handling

The server provides detailed error messages:

- Missing API key: Clear error on startup
- API errors: Formatted with status code and message
- Invalid requests: Descriptive validation errors

## License

MIT

## Contributing

Contributions welcome! Please open an issue or PR.

## Support

For issues or questions:
1. Check the [MCP documentation](https://modelcontextprotocol.io)
2. Review [Google Gemini API docs](https://ai.google.dev/docs)
3. Open an issue in this repository
