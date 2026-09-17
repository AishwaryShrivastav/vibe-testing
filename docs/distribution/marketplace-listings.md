# Marketplace submission kit

Current submission state and next actions: [launch-status.md](launch-status.md).

Use the same product facts on every listing. Change only the length required by the form.

## Canonical listing

**Name:** vibe-testing

**Short description:** Code-aware browser testing for AI coding agents. Test real routes in Playwright, remember regressions, and produce an evidence-backed release report.

**Long description:** vibe-testing gives coding agents a senior-QA workflow. It reads routes, forms, field names, and existing tests from the codebase before opening a browser. Thirteen MCP tools cover discovery, authenticated flows, exact scenarios, screenshots, coverage, regression memory, and a self-contained HTML report. The browser runner makes zero internal LLM calls and requires no API key.

**Repository:** https://github.com/AishwaryShrivastav/vibe-testing

**Website:** https://aishwaryshrivastav.github.io/vibe-testing/

**npm:** https://www.npmjs.com/package/vibe-testing

**License:** MIT

**Icon:** `assets/vibe-testing-icon-512.png` for MCPB; `assets/vibe-testing-icon-400.png` where a marketplace requires 400 by 400 pixels.

**MCP command:** `npx -y vibe-testing@latest --mcp`

**First-run command:** `npx vibe-testing@latest init`

## Cursor Marketplace

The repository already contains the portable Agent Plugin files `plugin.json`, `mcp.json`, and `skills/release-qa/SKILL.md`.

1. Open https://cursor.com/marketplace/publish while signed into Cursor.
2. Submit `https://github.com/AishwaryShrivastav/vibe-testing`.
3. Use the canonical name and description above.
4. Confirm the preview exposes both the `release-qa` skill and `vibe-testing` MCP server.

The final submission uses the owner's Cursor account and remains an account/UI action.

## Claude plugin directory

The repository is installable as a Claude Code marketplace today:

```bash
claude plugin marketplace add AishwaryShrivastav/vibe-testing
claude plugin install vibe-testing@vibe-testing
```

Submit the public plugin at https://platform.claude.com/plugins/submit using the canonical listing. Confirm that Claude accepts the repository's root Agent Plugin manifest. If the form requires `.claude-plugin/plugin.json`, add the Claude-specific wrapper in a separate compatibility commit after reviewing the validation error rather than maintaining duplicate manifests preemptively.

The final submission uses the owner's Anthropic account and remains an account/UI action.

## Smithery

Smithery's current publishing documentation accepts local stdio servers as pre-built MCPB bundles. Prepare the validated artifact with:

```bash
npm ci
npm run build:mcpb
```

The command writes `artifacts/vibe-testing-0.4.5.mcpb`. It validates schema 0.4, installs locked production dependencies, tests the stdio handshake and 13-tool list, packs the archive, and inspects the result. Uploading it through https://smithery.ai/new remains a manual account action. The [MCPB guide](mcpb.md) records the runtime prerequisite and listing facts.

## PulseMCP

Open https://www.pulsemcp.com/submit and provide the canonical listing, npm link, GitHub repository, and this MCP config:

```json
{
  "mcpServers": {
    "vibe-testing": {
      "command": "npx",
      "args": ["-y", "vibe-testing@latest", "--mcp"]
    }
  }
}
```

The form currently rejects automated requests with HTTP 403. Submission requires the owner's browser session.

## mcp.so

Open https://mcp.so/submit?type=server and use the canonical listing. Choose a local stdio server when the form asks for transport. Link `server.json` as the official Registry metadata and use `assets/vibe-testing-icon-400.png` for the icon.

The final submission uses the owner's account and remains an account/UI action.

## Cline

Submission issue #2554 is open:

https://github.com/cline/mcp-marketplace/issues/2554

The issue includes the repository and 400 by 400 icon required by Cline. Monitor the issue for maintainer feedback; do not open a duplicate.

## agent-plugins directory

Submission issue #134 is open:

https://github.com/dmgrok/agent-plugins/issues/134

The issue points to the repository's root Agent Plugin manifest. Monitor it for maintainer feedback; do not open a duplicate.
