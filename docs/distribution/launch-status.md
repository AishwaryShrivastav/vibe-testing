# Launch and distribution status

Last verified: 2026-10-15

## Product-owned release state

| Surface | State | Evidence |
| --- | --- | --- |
| Source | `0.4.6` on `main`; no open product-repo pull requests or issues | [Repository](https://github.com/AishwaryShrivastav/vibe-testing) |
| Product site | Live; `vibetesting.tfgstudio.com` redirects to `testing.tfgstudio.com` (HTTP 200) | [Live site](https://testing.tfgstudio.com/) |
| Continuous integration | Release verification last recorded for `0.4.6`; this documentation update is verified locally below | [CI runs](https://github.com/AishwaryShrivastav/vibe-testing/actions/workflows/ci.yml) |
| Pages deployment | Live site responds with the vibe-testing page title | [Live site](https://testing.tfgstudio.com/) |
| npm | `0.4.6` is the `latest` release; npm metadata still names the redirecting domain as homepage | [npm package](https://www.npmjs.com/package/vibe-testing) |
| MCP Registry | `0.4.6` is active and latest | [Registry API](https://registry.modelcontextprotocol.io/v0.1/servers?search=vibe-testing) |
| Glama | Existing listing has an inspected 13-tool schema and 3.5/5 score, scored 2026-09-17; ownership/claim state was not verified | [Glama schema page](https://glama.ai/mcp/servers/AishwaryShrivastav/vibe-testing/schema) |

The Glama inspection predates `0.4.6` and shows 13 tools. The current package and source describe 14 tools; request a reinspection through the listing owner account if the discrepancy matters to users.

## External submissions

These are external gates. Keep them open and do not create duplicates.

| Directory | State | Link |
| --- | --- | --- |
| awesome-mcp-servers | Merged 2026-09-21 | [PR #14575](https://github.com/punkpeye/awesome-mcp-servers/pull/14575) |
| awesome-ai-testing | Open; mergeable; `awesome-lint` check passed; no maintainer decision yet | [PR #142](https://github.com/tugkanboz/awesome-ai-testing/pull/142) |
| awesome-testing-tools | Open; mergeable; no maintainer decision yet | [PR #148](https://github.com/ZoranPandovski/awesome-testing-tools/pull/148) |
| Cline marketplace | Open submission issue | [Issue #2554](https://github.com/cline/mcp-marketplace/issues/2554) |
| agent-plugins directory | Open submission issue | [Issue #134](https://github.com/dmgrok/agent-plugins/issues/134) |
| Awesome Playwright | Submitted 2026-10-15; PR open and mergeable | [PR #243](https://github.com/mxschmitt/awesome-playwright/pull/243) |
| TheJambo awesome-testing | Submitted 2026-10-15; PR open and mergeable; dead-link check passed | [PR #301](https://github.com/TheJambo/awesome-testing/pull/301) |
| mcpHQ awesome-mcp-servers | Submitted 2026-10-15; PR open and mergeable; local validation and generated-file checks passed | [PR #263](https://github.com/mcpHQ/awesome-mcp-servers/pull/263) |

Cursor Marketplace, the Claude plugin directory, Smithery, and PulseMCP still require account or browser submission. The prepared copy and exact form steps are in [marketplace-listings.md](marketplace-listings.md). The current GTM campaign defers mcp.so's paid submission until user demand is established. No social post, direct message, or email was sent during this pass.

## Next GTM actions

1. Get the first external builder to run vibe-testing on a real app change and open a completed HTML report. Record framework, acquisition source, tested flow, useful result, setup friction, and whether they would run it again; do not count installs or downloads as activations.
2. Monitor the seven open directory submissions above for maintainer feedback and merge decisions. Do not reopen or duplicate them.
3. From the owner's account, refresh the Glama inspection if possible and submit Cursor, Claude, Smithery, and PulseMCP listings where their forms accept the current package. Record each resulting URL.
4. Use a real external report to choose a concrete example for later community publication. The existing GTM campaign reserves social and HN posts for the founder.

The acquisition gap remains first-user evidence: the current verified activated-external-user count is zero. Directory review is a distribution step, not an activation.

## Local verification for this update

On 2026-10-15, `npm ci`, `npm test` (209 passed, 12 skipped), `npm run build`, and `npm run build:mcpb` completed successfully. The first test run failed three browser-dependent tests because this machine lacked the matching Chromium build; those tests passed after installing the required browser. The generated archive in `artifacts/` was not committed.
