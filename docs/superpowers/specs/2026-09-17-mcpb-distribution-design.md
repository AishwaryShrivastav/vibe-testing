# MCPB distribution design

## Goal

Produce one installable MCPB artifact from the existing `vibe-testing` Node server. The artifact must work as a local stdio server in hosts that implement MCPB, including Claude Desktop, and it must be suitable for Smithery's local-server publishing flow. This work does not publish the artifact or change the npm package version.

## Package shape

The bundle contains the compiled `dist/` server, production `node_modules`, `package.json`, the product icon, and a root `manifest.json`. The manifest uses MCPB schema 0.4, launches `dist/mcp-server.js` with the host's Node runtime, declares the 13 static tools, and lists macOS, Windows, and Linux support.

The build script creates a clean staging directory, installs production dependencies with the lockfile, validates the manifest with `@anthropic-ai/mcpb@2.1.2`, and writes `artifacts/vibe-testing-<version>.mcpb`. The CLI version is pinned so a future upstream release cannot silently change the build.

## Runtime boundary

The MCP server starts and lists tools without a browser download. Browser execution needs Playwright Chromium, which Playwright stores outside `node_modules`. Shipping one Chromium binary would make the artifact platform-specific and much larger. The first release therefore documents the one-time `npx vibe-testing@latest install-browser` step. A future release can add platform-specific browser bundles if install data shows that the extra size is justified.

## Validation

Automated tests check manifest identity, npm-version parity, the server entry point, supported platforms, and exact parity between the 13 manifest tool names and the MCP server. The release check builds the bundle, validates it with the official CLI, inspects the ZIP layout, launches the unpacked server over stdio, and verifies its MCP handshake and tool list.

## Distribution boundary

The branch prepares the artifact and submission instructions only. It does not publish to npm, Smithery, Anthropic, or another registry.
