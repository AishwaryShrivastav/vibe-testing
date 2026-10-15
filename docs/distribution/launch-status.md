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
| npm downloads | Official npm API counted 5,381 cumulative downloads through 2026-10-12; the site refreshes this count and the README has a live badge | [npm downloads API](https://api.npmjs.org/downloads/range/2025-01-01:2026-10-12/vibe-testing) |
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
| MCP.Directory | Submitted 2026-10-15; accepted for review, with publication promised within 24 hours; no public listing URL yet | [Submission page](https://mcp.directory/submit) |
| mcpservers.org | Submitted 2026-10-15 on the free plan; confirmation says review within 2 weeks; no public listing URL yet | [Submission page](https://mcpservers.org/submit) |
| mcp.tc | Submitted 2026-10-15; server found, awaiting human approval; proposed listing URL is inactive until approval | [Submission status](https://mcp.tc/s/SIEStnNOmnwNesuW) |
| Reddit r/SideProject | Published and verified by the founder on 2026-10-15; no repost or crosspost made here | [Launch post](https://www.reddit.com/r/SideProject/comments/1x6chh1/i_built_a_free_browser_testing_tool_that_shows/) |
| X personal profile | Published 2026-10-15; a single build note with a product link, no engagement request | [Post](https://x.com/aishshrivastava/status/2110778188058263700) |
| PulseMCP | New submissions temporarily paused by the operator; no submission made | [Submission page](https://www.pulsemcp.com/submit) |
| Smithery | Published 2026-10-15; release `c1db8194-5e67-49b6-9894-69e2e40c3ba4` succeeded with 14 tools and a downloadable local bundle | [Live listing](https://smithery.ai/servers/aish/vibe-testing) |
| Cursor Marketplace | Publisher application submitted 2026-10-15 under Tech For Good; on-screen receipt says review pending, with no public listing yet | [Publisher portal](https://cursor.com/marketplace/publish) |
| Claude plugin directory | Submitted 2026-10-15; earlier revision passed security scan, content-policy review pending; current `main` was detected for a new scan. No public listing yet. The listing's captured privacy-policy field still says “No value” | [Submission status](https://claude.ai/directory/manage/plugins/d502008f-fa6e-425a-bb78-14dd84cecd29) |

Cursor Marketplace has a publisher application in review, but no public plugin listing. The Claude plugin directory submission is in content-policy review; its code scan sees current `main`, but its listing details captured an empty privacy field. Smithery is published. PulseMCP is paused by its operator. The prepared copy and exact form steps are in [marketplace-listings.md](marketplace-listings.md). The current GTM campaign defers mcp.so's paid submission until user demand is established. AgentoolRank's free form failed twice with a server error, and testingtools.ai's submission page rendered without a form. AllMCPs requires agreement to its binding Terms on submission, so it was left unsubmitted. MCPVault, MCP Market, MCP Harbor, and MCPRepository already list vibe-testing; no duplicate was sent. No individual outreach or paid placement was used.

## Next GTM actions

1. Get the first external builder to run vibe-testing on a real app change and open a completed HTML report. Record framework, acquisition source, tested flow, useful result, setup friction, and whether they would run it again; do not count installs or downloads as activations.
2. Monitor the seven earlier open directory submissions and the three new review queues above. Do not reopen or duplicate them. Check the mcp.tc status URL for its eventual public listing.
3. From the owner's account, refresh the Glama inspection if possible and correct Claude's captured privacy-policy field when an edit path or reviewer feedback appears. Follow up on Cursor's publisher review before requesting an actual plugin listing. Recheck PulseMCP when submissions reopen. Record each resulting URL.
4. Use a real external report to choose a concrete example for later community publication. One X build note is live; further posts should respond to actual testing problems rather than repeat a launch announcement.

The acquisition gap remains first-user evidence: the current verified activated-external-user count is zero. Directory review is a distribution step, not an activation.

## Local verification for this update

On 2026-10-15, `npm ci`, `npm test` (209 passed, 12 skipped), `npm run build`, and `npm run build:mcpb` completed successfully for this note update. The generated archive in `artifacts/` was not committed.
