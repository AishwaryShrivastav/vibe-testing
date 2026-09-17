# Zero-friction MCP reliability design

**Date:** 2026-09-17
**Status:** Approved for planning
**Product:** vibe-testing

## Problem

Dogfooding vibe-testing 0.4.5 against AI Astrology Guru proved that the MCP browser tools create useful evidence on a real TanStack Start application. It also exposed an onboarding path that can fail silently or report misleading results:

- the CLI does not execute through `npx` or package-manager symlinks;
- TanStack Router and TanStack Start are misclassified as a generic React SPA;
- zero discovered scenarios end in a stack trace;
- generated and dependency files inflate test counts;
- URL detection can choose the wrong development server;
- generated setup files assume email/password authentication and `/login`;
- `run_full_test` cannot recover when static route discovery fails.

The release succeeds when a developer can add the MCP server, ask an agent to test a running app, and receive an evidence-backed report without knowing vibe-testing's internals.

## Approaches considered

### 1. Patch the reported defects only

Fix the CLI entrypoint and TanStack parser, then publish a patch. This is the smallest release, but it leaves onboarding dependent on generated editor files and leaves future unsupported frameworks with the same zero-route failure.

### 2. Replace static analysis with browser crawling

Make the live browser the only source of routes and scenarios. This supports unfamiliar frameworks, but loses code-aware context, hidden routes, API knowledge, and the core differentiation from generic browser tools.

### 3. Keep code awareness and add runtime recovery

Repair the reported defects, make configuration available through MCP, and let `run_full_test` combine static analysis with live-server detection and link crawling. This preserves code-aware testing while ensuring unsupported frameworks still produce useful work. This is the selected approach.

## Product flow

The primary path is MCP-first:

1. The user or coding agent adds the vibe-testing MCP server.
2. MCP initialization returns concise operating instructions that name the recommended workflow and safety boundaries.
3. The agent calls `configure` with a project path. The tool detects the frontend root, framework, running server, and likely authentication method, then writes a minimal `vibe.config.json` and optional project guidance.
4. The agent calls `run_full_test`. The tool revalidates the server, scans the codebase, derives scenarios, runs browser checks, and generates a report.
5. When static route discovery returns nothing, the tool crawls same-origin links from the running application and builds safe smoke scenarios from the observed pages.
6. The report distinguishes static routes, crawled pages, executed scenarios, skipped authentication flows, and failures. It never describes discovered files as tested routes.

The CLI remains supported for humans and CI. `npx vibe-testing@latest init`, `run`, and `converge` must behave the same whether invoked directly, through `.bin`, or through an `npx` temporary symlink.

## Architecture

### Runtime entrypoint

Replace exact path-string comparison with a direct-execution check that resolves symlinks and macOS path aliases before comparing the invoked script with the current module. Importing `src/cli` in tests must continue to avoid parsing process arguments.

### Framework and route discovery

Add explicit `tanstack-router` detection when dependencies or source layout indicate TanStack Router or TanStack Start. Parse file routes under `src/routes` and support:

- `__root` as layout metadata rather than a public route;
- `index` as the containing directory route;
- `$param` as a dynamic segment;
- pathless layout files and folders beginning with `_`;
- route files using TanStack's common suffix conventions.

Static scanning must apply a shared exclusion policy to `node_modules`, `.git`, `.vibe`, build output, coverage output, package-manager caches, and generated files. Counts shown to users must derive from the typed product model and execution results, rather than raw file matches.

### Server detection

Create a bounded server detector that uses evidence in this order:

1. an explicit URL;
2. configured URL;
3. package scripts and common framework config;
4. active local listening ports;
5. bounded probes of common development ports.

Candidates must return HTML and match project evidence where possible. The detector returns its choice and supporting evidence so the report can explain it. It must not scan arbitrary networks.

### MCP configuration

Add a `configure` tool without changing existing tool names or inputs. It accepts `codebase_path` and an optional URL. It returns detected project details and writes only the minimum stable files:

- `vibe.config.json`;
- `.vibe/` in `.gitignore` when possible;
- `VIBE.md` only when useful project-specific guidance can be generated without inventing credentials.

The tool never writes placeholder passwords. OAuth detection produces guidance such as “Google OAuth observed at `/auth`; establish a browser session manually or provide stored state.”

The MCP server initialization response includes short instructions for `configure -> run_full_test -> generate_report`. Existing editor-specific setup files remain available for compatibility, but they are no longer required for agents to understand the workflow.

### Self-healing full test

`run_full_test` becomes the reliable one-shot entrypoint:

1. resolve project root and frontend app;
2. detect or validate the live URL;
3. detect framework and parse routes;
4. crawl same-origin links when no usable public scenarios exist;
5. identify likely authentication method from source and page controls;
6. run safe public scenarios;
7. skip blocked authentication flows with an actionable explanation;
8. generate the report even when no scenario can safely execute.

Recovery remains bounded. It will not submit destructive forms, cross origins, bypass authentication, or manufacture credentials.

## Error handling

Expected setup gaps return structured, actionable results rather than stack traces. Examples include:

- no live server found, with attempted sources and a command example;
- framework detected but no static routes parsed, followed by crawl status;
- OAuth-only authentication detected, with the exact limitation and next action;
- zero safe scenarios, with a valid diagnostic report and non-success verdict;
- browser dependency missing, with the existing installation command.

Unexpected programming errors still fail with a nonzero exit code and a concise causal message. MCP responses should include machine-readable status fields plus a short human explanation.

## Reports and trust

Reports use separate measures for:

- routes discovered from code;
- pages discovered from the live application;
- scenarios attempted;
- scenarios passed, failed, or skipped;
- source and browser evidence collected.

No metric may use “tested” unless a browser scenario actually ran. Generated reports, dependency files, and build artifacts cannot contribute to route or test totals.

## Setup output

CLI output must render real newlines. The generated `VIBE.md` describes authentication as unknown until detected and does not assume `/login`, email fields, or password fields. Initialization adds `.vibe/` to `.gitignore` idempotently.

## Compatibility

- Preserve all 13 existing MCP tools and their current schemas.
- Add `configure` as a new tool.
- Existing configuration files remain valid.
- Existing supported frameworks keep their current route behavior.
- No LLM or external API dependency is introduced.
- The package remains free, open source, and locally executed.

## Verification

Automated tests cover:

- direct, `.bin`, `npx`-style symlink, and macOS realpath CLI execution;
- TanStack Start and Router route conventions;
- ignored build and dependency directories;
- graceful zero-route and zero-scenario behavior;
- server selection from explicit URL, config, scripts, active ports, and common ports;
- OAuth recognition without invented credentials;
- idempotent configuration and `.gitignore` updates;
- live-link crawl fallback;
- truthful report counts;
- backward compatibility for all existing MCP tools.

The release candidate is dogfooded against AI Astrology Guru. Acceptance requires correct detection of TanStack, the active port, Google OAuth, real routes, and a generated report without local `node_modules` patches.

## Release and distribution

Ship as the next patch release after tests, build, package smoke test, and Guruji dogfood pass. Update README, changelog, MCP setup docs, agent/plugin metadata, and website copy around the MCP-first workflow.

Use `vibetesting.tfgstudio.com` as the canonical product domain while keeping GitHub Pages as the deployment source. Configure the custom domain through GitHub Pages and Cloudflare DNS, add the repository `CNAME`, and update canonical metadata, sitemap, package links, and documentation. The existing GitHub Pages URL redirects to the canonical domain after certificate provisioning.

Submit the repaired release to relevant MCP and testing directories only after the package and custom domain are live.

## Out of scope

- hosted test execution;
- an account system or billing;
- visual-regression model inference;
- bypassing OAuth or CAPTCHA;
- broad refactoring unrelated to onboarding reliability;
- a demo video.
