# MCPB bundle

The MCPB build packages the local stdio server for Claude Desktop and Smithery's local-server flow. It does not publish anything.

## Build and verify

```bash
npm ci
npm run build:mcpb
```

The command builds TypeScript, installs locked production dependencies in a clean staging directory, validates the manifest with `@anthropic-ai/mcpb@2.1.2`, checks the server handshake and all 13 tools, packs the bundle, and inspects the result. The artifact is written to `artifacts/vibe-testing-0.4.5.mcpb`.

The package version comes from `package.json`. Keep `mcpb/manifest.json` on the same version; the test suite rejects version drift.

## Install

Open the `.mcpb` file with a host that supports MCPB. Claude Desktop accepts local bundles from Settings, Extensions, Advanced settings.

The server starts without an API key. Browser runs need Playwright Chromium once on each machine:

```bash
npx vibe-testing@latest install-browser
```

Playwright keeps Chromium outside the npm dependency tree. The current bundle omits that platform-specific download, which keeps one artifact usable on macOS, Windows, and Linux.

## Smithery handoff

Smithery accepts a pre-built MCPB for local stdio servers. Build the artifact, sign in at `smithery.ai/new`, choose the local MCPB option, upload the file, and complete the listing. The upload is intentionally outside this repository workflow.

Use these listing facts:

- Name: `vibe-testing`
- Transport: local stdio
- Runtime: Node.js 20 or newer
- Authentication: none
- Tools: 13
- Browser prerequisite: one Playwright Chromium install

## Sources

- [MCPB repository and packaging overview](https://github.com/modelcontextprotocol/mcpb)
- [MCPB manifest schema 0.4](https://github.com/modelcontextprotocol/mcpb/blob/main/schemas/mcpb-manifest-v0.4.schema.json)
- [MCPB CLI](https://github.com/modelcontextprotocol/mcpb/blob/main/CLI.md)
- [Smithery local publishing](https://smithery.ai/docs/build/publish)
