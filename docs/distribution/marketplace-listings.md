# Marketplace submission kit

Current submission state and next actions: [launch-status.md](launch-status.md).

Use the same product facts on every listing. Change only the length required by the form.

## Canonical listing

**Name:** vibe-testing

**Short description:** Code-aware browser testing for AI coding agents. Test real routes in Playwright, remember regressions, and produce an evidence-backed release report.

**Long description:** vibe-testing gives coding agents a senior-QA workflow. It reads routes, forms, field names, and existing tests from the codebase before opening a browser. Fourteen MCP tools cover discovery, authenticated flows, exact scenarios, screenshots, coverage, regression memory, and a self-contained HTML report. The browser runner makes zero internal LLM calls and requires no API key.

**Repository:** https://github.com/AishwaryShrivastav/vibe-testing

**Website:** https://testing.tfgstudio.com/

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

The publisher application was submitted on 2026-10-15 under Tech For Good. Cursor displayed a receipt saying the application was received and will be reviewed. No public plugin listing exists yet; watch the publisher account for the review decision before claiming marketplace availability.

## Claude plugin directory

The repository is installable as a Claude Code marketplace today:

```bash
claude plugin marketplace add AishwaryShrivastav/vibe-testing
claude plugin install vibe-testing@vibe-testing
```

The [Claude directory submission](https://claude.ai/directory/manage/plugins/d502008f-fa6e-425a-bb78-14dd84cecd29) was sent on 2026-10-15 after the owner approved Anthropic's Software Directory Terms and Directory Policy. The earlier revision passed its security scan; content-policy review is pending. Claude has detected current `main` for a new code scan. The plugin on GitHub pins its `npx` dependency and links the [privacy notice](../../PRIVACY.md), but the listing's privacy-policy field remains “No value” because Claude captured listing details at initial submission. No edit route was verified during review. It is not a published listing.

## Smithery

Smithery's current publishing documentation accepts local stdio servers as pre-built MCPB bundles. Prepare the validated artifact with:

```bash
npm ci
npm run build:mcpb
```

The command writes `artifacts/vibe-testing-0.4.6.mcpb`. It validates schema 0.4, installs locked production dependencies, tests the stdio handshake and 14-tool list, packs the archive, and inspects the result. Smithery's web form accepts hosted HTTP servers; the local MCPB was published through the official Smithery CLI. [The listing is live](https://smithery.ai/servers/aish/vibe-testing) with 14 tools and a downloadable bundle. The [MCPB guide](mcpb.md) records the repeatable publishing workflow.

## PulseMCP

https://www.pulsemcp.com/submit currently says new submissions are temporarily paused (page updated 2026-09-03). The product is already in the official MCP Registry. When PulseMCP reopens, provide the canonical listing, npm link, GitHub repository, and this MCP config:

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

No PulseMCP submission has been made; do not count this as a listing.

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
