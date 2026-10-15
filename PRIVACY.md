# Vibe Testing privacy notice

Last updated: 15 October 2026

This notice covers the open-source Vibe Testing CLI, MCP server, and Claude plugin. Vibe Testing runs on your computer. It does not require a Vibe Testing account, send your project files or test results to a Vibe Testing service, or include product analytics in the CLI or MCP server.

## What the tool reads and saves

To plan and run checks, the tool reads the project files you point it at and opens the application URL you provide in a local Playwright browser. It saves working state under the project's `.vibe/` directory. This can include route and test metadata, browser screenshots, request and error evidence, an HTML report, run history, and authentication information used during testing. Credentials learned from login steps can be saved in `.vibe/memory/project-intel.json` for reuse. These local files are **not encrypted**. The setup command adds `.vibe/` to `.gitignore`; check that it remains excluded before sharing or committing a project.

Your application and any third-party services it uses receive the browser requests made during a test, just as they would for a person using the app. If you use Vibe Testing through an AI editor or MCP client, that client may send tool inputs or outputs to its model provider under the client's own settings and privacy terms. Vibe Testing does not control that transmission. Installing the npm package and opening project links also contact the relevant package registry and websites.

## Your controls

Use a test account and test data where possible. Avoid placing production secrets in `VIBE.md`, `vibe.config.json`, prompts, or test steps. Review reports and screenshots before sharing them. Run `npx vibe-testing@latest reset` in the project to remove the `.vibe/` directory, including saved memory, screenshots, and reports. Remove any credentials you put in other configuration files separately.

The maintainers do not receive your local test data and cannot retrieve or delete it for you. Questions or suspected privacy issues can be raised privately through [GitHub's security advisory form](https://github.com/AishwaryShrivastav/vibe-testing/security/advisories/new), or through a [public issue](https://github.com/AishwaryShrivastav/vibe-testing/issues) if it contains no sensitive information.
