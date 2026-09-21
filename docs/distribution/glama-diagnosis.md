# Glama listing diagnosis

Last verified: 2026-09-17

## Public state

The public listing is unclaimed. Its schema page has no inspected tools or capabilities because inspection has never run. The public API now requires a Glama API key, so the listing page is the available unauthenticated check.

Listing: https://glama.ai/mcp/servers/AishwaryShrivastav/vibe-testing/schema

## Repository proof

The root `glama.json` follows Glama's official schema:

```json
{
  "$schema": "https://glama.ai/mcp/schemas/server.json",
  "maintainers": ["AishwaryShrivastav"]
}
```

The live schema requires `maintainers` as an array of unique GitHub usernames. Local validation is part of the launch checks.

## Remaining action

1. Sign into Glama with the GitHub account `AishwaryShrivastav`.
2. Open the listing and run **Claim ownership** again. Glama's documentation says the claim flow fetches the latest `glama.json`.
3. Trigger inspection after the claim completes.
4. Confirm that the listing shows 14 tools and a quality score.
5. Let the existing `punkpeye/awesome-mcp-servers` PR #14575 update from the evaluated listing. Its submission check already passes. Do not close it or open a replacement.

No source-code or manifest blocker remains. Claiming and starting inspection require the owner's authenticated Glama session.
