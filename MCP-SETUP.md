# MCP Setup — Add vibe-test to Any Project

The fastest way: run `npx vibe-test@latest init` in your project root. It auto-detects your editors and writes all configs.

Or configure manually:

## Claude Code

Add to `.mcp.json` in your project root:
```json
{
  "mcpServers": {
    "vibe-test": {
      "command": "npx",
      "args": ["-y", "vibe-test@latest", "--mcp"]
    }
  }
}
```

Or globally in `~/.claude/settings.json`:
```json
{
  "mcpServers": {
    "vibe-test": {
      "command": "npx",
      "args": ["-y", "vibe-test@latest", "--mcp"]
    }
  }
}
```

## Cursor

Add to `.cursor/mcp.json` in your project:
```json
{
  "mcpServers": {
    "vibe-test": {
      "command": "npx",
      "args": ["-y", "vibe-test@latest", "--mcp"]
    }
  }
}
```

## Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:
```json
{
  "mcpServers": {
    "vibe-test": {
      "command": "npx",
      "args": ["-y", "vibe-test@latest", "--mcp"]
    }
  }
}
```

## Usage (after setup)

Tell your editor:
```
Scan this codebase and test it against http://localhost:3000
```

Or more specifically:
```
Test the login flow — scan the codebase, get context for login, 
log in with test@example.com / pass123, explore the dashboard, 
run a create-user scenario, and generate a report
```

## Tool Workflow (what the AI will do)

1. `scan_codebase` — reads your code, finds routes/forms/gaps
2. `get_context` — reads actual source files for the feature (real selectors)
3. `login` — authenticates in a real browser
4. `explore_page` — clicks everything, finds what breaks
5. `execute_scenario` — runs targeted test flows
6. `generate_report` — HTML report with screenshots, opens in browser
7. `cleanup` — closes browsers
