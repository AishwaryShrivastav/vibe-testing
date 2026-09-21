# Launch and distribution status

Last verified: 2026-09-17

## Product-owned release state

| Surface | State | Evidence |
| --- | --- | --- |
| Source | Product code baseline `77da8b3`; no open repository pull requests or issues | [Repository](https://github.com/AishwaryShrivastav/vibe-testing) |
| Product site | `0.4.6` custom-domain files prepared; DNS and Pages activation remain with the release controller | [Canonical site](https://vibetesting.tfgstudio.com/) |
| Continuous integration | Passing for `77da8b3` | [CI run](https://github.com/AishwaryShrivastav/vibe-testing/actions/runs/35201724028) |
| Pages deployment | Passing for launch-site commit `0b600ac` | [Pages run](https://github.com/AishwaryShrivastav/vibe-testing/actions/runs/35199859372) |
| npm | `0.4.5` is the `latest` release | [npm package](https://www.npmjs.com/package/vibe-testing) |
| MCP Registry | `0.4.5` is active and latest | [Registry listing](https://registry.modelcontextprotocol.io/?q=io.github.AishwaryShrivastav%2Fvibe-testing) |
| Glama | Listing exists but is unclaimed and has not inspected its tools | [Glama schema page](https://glama.ai/mcp/servers/AishwaryShrivastav/vibe-testing/schema) |

The npm record for 0.4.5 still shows the repository README as its homepage because that metadata was published before the package homepage changed to the product site. The next package release will carry the current homepage. This does not block installation or discovery.

## External submissions

These are external gates. Keep them open and do not create duplicates.

| Directory | State | Link |
| --- | --- | --- |
| awesome-mcp-servers | Open; submission check passes; Glama evaluation is still required | [PR #14575](https://github.com/punkpeye/awesome-mcp-servers/pull/14575) |
| awesome-ai-testing | Open; GitHub reports an unstable merge state; no checks or maintainer decision yet | [PR #142](https://github.com/tugkanboz/awesome-ai-testing/pull/142) |
| awesome-testing-tools | Open; mergeable; no maintainer decision yet | [PR #148](https://github.com/ZoranPandovski/awesome-testing-tools/pull/148) |
| Cline marketplace | Open submission issue | [Issue #2554](https://github.com/cline/mcp-marketplace/issues/2554) |
| agent-plugins directory | Open submission issue | [Issue #134](https://github.com/dmgrok/agent-plugins/issues/134) |

Cursor Marketplace, the Claude plugin directory, Smithery, PulseMCP, and mcp.so still require account or browser submission. The prepared copy and exact form steps are in [marketplace-listings.md](marketplace-listings.md). No social post, direct message, or new listing submission was sent during this pass.

## Next GTM actions

1. Sign into Glama as `AishwaryShrivastav`, claim the existing listing, start inspection, and verify that the page shows 14 tools and a quality score.
2. Leave the three upstream directory pull requests open. Act only on maintainer feedback; do not open replacement pull requests.
3. Submit the prepared listings for Cursor, Claude, Smithery, PulseMCP, and mcp.so from the owner's accounts. Record each resulting URL here.
4. Recruit three founding QA runs through the product site's existing GitHub issue flow. Record framework, setup friction, first useful result, blocker, and whether the user would run it again. Do not store credentials or private application data.
5. Use those three runs to choose the strongest concrete example for a later Product Hunt, Hacker News, or community launch. Draft and review that launch separately before posting.

The current launch blockers are distribution access and first-user evidence. Site code, npm publication, and MCP Registry publication are complete.
