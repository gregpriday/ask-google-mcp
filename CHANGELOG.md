# Changelog

## 0.4.0 - 2026-03-06

- Refactored the MCP server into importable modules so production logic can be unit tested directly.
- Deferred `GOOGLE_API_KEY` validation until tool execution so MCP clients can still initialize and list tools.
- Added request timeouts, improved retry classification, and switched runtime validation to structured MCP errors.
- Restricted `output_file` behind `ASK_GOOGLE_ALLOW_FILE_OUTPUT=true` and a configurable base directory.
- Reworked tests to cover real source modules and added a stdio handshake test plus a gated live integration test.
- Added a GitHub Actions workflow for unit tests and CLI smoke checks.
