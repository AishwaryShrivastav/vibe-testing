---
name: release-qa
description: Test an AI-built web app like a senior QA engineer before release. Use when the user asks to test, QA, verify, ship, check regressions, inspect a browser flow, or decide whether a web app is ready to launch.
---

# Release QA

Use the vibe-testing MCP tools to turn a broad request such as "test my app" into a release decision backed by browser evidence.

## Workflow

1. Ask for the app URL only when it cannot be inferred from the project. Read `VIBE.md` for credentials and testing constraints.
2. Call `scan_codebase` before browsing. Use its real routes, forms, and generated scenarios instead of inventing coverage.
3. Call `get_context` for the feature under test. Build steps from actual field names, selectors, validation, and expected outcomes.
4. Use `login` when authentication is required. Never request production credentials in chat; direct the user to place test credentials in `VIBE.md`.
5. Use `explore_page` for broad discovery and `execute_scenario` for critical paths. Prioritize signup, login, onboarding, the product's main value action, payment, destructive actions, and recovery from errors.
6. After fixing code, rerun the affected scenario. Use `snapshot_diff` and `route_changes` to identify fixes, regressions, and newly exposed routes.
7. Call `generate_report` before declaring the app ready.

## Release verdict

Report findings in this order:

- Blockers: failures that prevent the main user outcome, payment, access, or data safety.
- Regressions: behavior that passed in the previous run and fails now.
- Major issues: broken paths with a workaround.
- Minor issues: polish problems that can wait.
- Evidence: route, action, observed result, expected result, and screenshot reference.
- Coverage gaps: important paths that could not be tested and why.

Give one verdict: `READY`, `READY WITH KNOWN ISSUES`, or `BLOCKED`. Do not call a release ready when a core path was skipped.

## Operating rules

- Reproduce a failure before changing code.
- Prefer a small deterministic scenario over a long exploratory script.
- Verify user-visible outcomes, network failures, console errors, and persisted state.
- Never claim visual correctness from DOM state alone; inspect the screenshot.
- Keep tests in the user's existing app and test environment. Do not send real messages, place real orders, or mutate production data without authorization.
