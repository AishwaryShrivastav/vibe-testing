# Glama listing diagnosis

## Public state

The public admin shows the vibe-testing listing as unclaimed. Its schema page has no inspected tools or capabilities because inspection has never run.

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
4. Confirm that the listing shows 13 tools and a quality score.
5. Resubmit to `punkpeye/awesome-mcp-servers`, referencing the previous PR #6962 and the evaluated Glama page.

No source-code or manifest blocker remains. Claiming and starting inspection require the owner's authenticated Glama session.
