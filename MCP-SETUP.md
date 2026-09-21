# MCP Setup — Add vibe-test to Any Project

Run `npx vibe-testing@latest init` in your project root. It detects your editors and writes the MCP configuration. The MCP server then follows `configure` → `run_full_test` → `generate_report`.

Or configure manually:

## Claude Code

Add to `.mcp.json` in your project root:
```json
{
  "mcpServers": {
    "vibe-test": {
      "command": "npx",
      "args": ["-y", "vibe-testing@latest", "--mcp"]
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
      "args": ["-y", "vibe-testing@latest", "--mcp"]
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
      "args": ["-y", "vibe-testing@latest", "--mcp"]
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
      "args": ["-y", "vibe-testing@latest", "--mcp"]
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

1. `configure` — detects the framework, active server, and authentication method
2. `run_full_test` — discovers routes, runs safe scenarios, and writes a report
3. `get_context` — reads source files when a targeted follow-up needs exact selectors
4. `execute_scenario` — runs a focused follow-up
5. `generate_report` — refreshes the HTML report with collected evidence
6. `cleanup` — closes browsers
