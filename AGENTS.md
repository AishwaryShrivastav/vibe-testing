# Repository operating notes

## Verify changes

Run these commands from the repository root:

```bash
npm ci
npm test
npm run build
npm run build:mcpb
```

The MCPB command performs its own package, handshake, and 13-tool checks. Do not commit generated archives from `artifacts/`.

## Deployment configuration

- Platform: GitHub Pages
- Production URL: https://aishwaryshrivastav.github.io/vibe-testing/
- Pages workflow: `.github/workflows/pages.yml`
- CI workflow: `.github/workflows/ci.yml`
- Package release: a `v*` tag runs `.github/workflows/ci.yml`, which publishes npm and then the MCP Registry entry after verification passes.

The Pages workflow runs only when `site/**` or the workflow file changes. Documentation-only pushes do not redeploy the site.

## Launch state

Use `docs/distribution/launch-status.md` as the current distribution record and `.agent/launch/status.md` as the local handoff. Update both when a release, listing, or submission state changes.

All product-owned pull requests through #10 are merged. Keep these upstream directory submissions open unless their maintainers resolve them:

- `punkpeye/awesome-mcp-servers#14575`
- `tugkanboz/awesome-ai-testing#142`
- `ZoranPandovski/awesome-testing-tools#148`

Do not open duplicate submissions. Do not send social posts or direct messages unless the user requests them.
