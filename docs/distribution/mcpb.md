# MCPB bundle

The MCPB build packages the local stdio server for Claude Desktop and Smithery's local-server flow. It does not publish anything.

## Build and verify

```bash
npm ci
npm run build:mcpb
```

The command builds TypeScript, installs locked production dependencies in a clean staging directory, validates the manifest with `@anthropic-ai/mcpb@2.1.2`, checks the server handshake and all 14 tools, packs the bundle, and inspects the result. The artifact is written to `artifacts/vibe-testing-0.4.6.mcpb`.

The package version comes from `package.json`. Keep `mcpb/manifest.json` on the same version; the test suite rejects version drift.

## Install

Open the `.mcpb` file with a host that supports MCPB. Claude Desktop accepts local bundles from Settings, Extensions, Advanced settings.

The server starts without an API key. Browser runs need Playwright Chromium once on each machine:

```bash
npx vibe-testing@latest install-browser
```

Playwright keeps Chromium outside the npm dependency tree. The current bundle omits that platform-specific download, which keeps one artifact usable on macOS, Windows, and Linux.

## Smithery publication

Smithery accepts a pre-built MCPB for local stdio servers. Its current web form only accepts hosted HTTP URLs. For this local bundle, sign in to the official Smithery CLI and publish through the Smithery API:

```bash
npx smithery auth login
npm run build:mcpb
node scripts/publish-smithery.mjs aish/vibe-testing
```

The publisher reads the bundled manifest and asks the running server for its full tool schemas. Smithery requires those schemas in its server card, while the MCPB manifest schema only permits tool names and descriptions. It uploads the unchanged bundle with the full card as release metadata. Never add `inputSchema` to `mcpb/manifest.json`; that would invalidate the portable bundle.

The first release was accepted on 2026-10-15: [aish/vibe-testing](https://smithery.ai/servers/aish/vibe-testing), release `c1db8194-5e67-49b6-9894-69e2e40c3ba4`. The public server record reports 14 tools and a downloadable stdio bundle.

Use these listing facts:

- Name: `vibe-testing`
- Transport: local stdio
- Runtime: Node.js 20 or newer
- Authentication: none
- Tools: 14
- Browser prerequisite: one Playwright Chromium install

## Sources

- [MCPB repository and packaging overview](https://github.com/modelcontextprotocol/mcpb)
- [MCPB manifest schema 0.4](https://github.com/modelcontextprotocol/mcpb/blob/main/schemas/mcpb-manifest-v0.4.schema.json)
- [MCPB CLI](https://github.com/modelcontextprotocol/mcpb/blob/main/CLI.md)
- [Smithery local publishing](https://smithery.ai/docs/build/publish)
