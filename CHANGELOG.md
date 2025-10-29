# Changelog

All notable changes to `@gpriday/ask-google-mcp` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Package name changed to `@gpriday/ask-google-mcp` (scoped package)
- README updated with global installation instructions using `npm install -g`
- Claude Desktop integration examples updated to use `ask-google-mcp` command

## [0.1.0] - 2025-10-29

**Initial public release** of Ask Google MCP Server.

### Features

#### Core Functionality
- **MCP server implementation** for Google search via Gemini AI
- **Search grounding** with automatic source citations
- **Configurable Gemini model** (defaults to gemini-2.5-pro-latest)
- **Structured output** optimized for AI agent consumption

#### Tool Definition
- **Enhanced tool description** with clear invocation cues
  - Trigger phrases: "check online", "ask google", "research"
  - Use cases: latest standards/versions, release comparisons, current info
- **JSON schema validation** with minLength (1) and maxLength (10,000) constraints
- **Concrete examples** in schema: ECMAScript, React, PostgreSQL, OpenSSL queries
- **Strict validation**: `additionalProperties: false` for input safety

#### Testing & Validation
- **40 comprehensive unit tests**:
  - Input validation tests (6 tests)
  - Tool description validation (22 tests)
  - Response formatting tests (4 tests)
  - Error categorization tests (5 tests)
  - Edge case tests (3 tests)
- **Environment validation script** with detailed remediation steps
- **Integration test** with MCP protocol handshake support

#### Error Handling & Stability
- **Categorized error codes**:
  - `[AUTH_ERROR]` - Invalid or missing API keys
  - `[QUOTA_ERROR]` - API quota or rate limit exceeded
  - `[TIMEOUT_ERROR]` - Request timeouts
  - `[API_ERROR]` - General API errors
- **Process stability handlers** for unhandled rejections and exceptions
- **Graceful shutdown** on SIGINT and SIGTERM

#### Security & Maintenance
- **Dependency management** following MCP best practices
  - Caret ranges for automatic security updates
  - Committed package-lock.json for reproducibility
- **Security audit scripts**:
  - `npm run security:audit` - Check vulnerabilities
  - `npm run security:fix` - Auto-fix issues
  - `npm run security:update` - Update dependencies

#### Configuration
- **Environment variables**:
  - `GOOGLE_API_KEY` (required) - Gemini API access
  - `GEMINI_MODEL` (optional) - Model selection
- **Pre-start validation** ensures environment is correctly configured
- **Model options**: gemini-2.5-pro-latest, gemini-2.5-flash-latest, gemini-flash-latest

#### Documentation
- **Comprehensive README** with:
  - Installation and setup instructions
  - Claude Desktop integration examples (macOS, Windows, Linux)
  - Tool usage documentation with examples
  - Model selection guide
  - Testing instructions (unit vs integration)
  - Dependency management best practices
- **API key template** (.env.example)
- **MIT License**

### Technical Details

- **Node.js**: >=18.0.0 required
- **Protocol**: MCP (Model Context Protocol) via stdio
- **Transport**: JSON-RPC 2.0 with Content-Length framing
- **Dependencies**:
  - `@google/generative-ai`: ^0.24.1
  - `@modelcontextprotocol/sdk`: ^1.0.4

---

## Release Categories

- **Added**: New features
- **Changed**: Changes to existing functionality
- **Deprecated**: Soon-to-be removed features
- **Removed**: Removed features
- **Fixed**: Bug fixes
- **Security**: Security improvements

[Unreleased]: https://github.com/gpriday/ask-google-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/gpriday/ask-google-mcp/releases/tag/v0.1.0
