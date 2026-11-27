# Test cases in markdown: `vibe-testing cases`

`run` and `converge` find what to test by reading your code. `cases` runs the test cases your team already wrote, from markdown (or JSON), and reports each case id as passed, failed, needing steps or skipped. No LLM is involved: a case runs only when it has explicit steps, so a pass always means its checks ran.

```bash
npx vibe-testing@latest cases docs/test-cases/login.md --url http://localhost:3000
npx vibe-testing@latest cases design/login/test-cases.md                  # static files via @base, no server
npx vibe-testing@latest cases cases.md steps.md --junit junit.xml --ledger evidence.jsonl --ledger-task E-20261127-login
```

MCP: `run_test_cases({ "files": ["/abs/path/cases.md"], "url": "http://localhost:3000" })`.

## Writing a case

A heading whose first word is a case id (`TC-...`) starts a case. It runs until the next heading of the same or a higher level, so `# TC-OUT-07: title` with `## Steps` sections inside works, and so does `### TC-r2-06 Wrong password (P0)`.

````markdown
### TC-r2-06 Wrong password (P0)
- Expect: one alert above the email field; email kept, password cleared.
- vibe: "Sign in with the password wrong and check one clear message appears."

```vibe
open v1.html?clean=1
fill #email aish@example.com
fill #pw wrong
press Enter
see #alert "That email and password do not match"
eval document.querySelector('#pw').value === ''
```
````

- **Priority** comes from `(P0)` in the heading, a `priority: P1` line, or a summary-table row (`| TC-FF-01 | Seed | P0 | yes |`).
- **The hint** (`vibe: "..."`, `Vibe-testing hint: ...`, or a `## vibe-testing hint` section) is kept in the report. A case with only a hint is reported as **needs steps**: an agent or a person writes the `vibe` block, it is never counted as passed.
- **Manual** cases (`(manual)` in the heading, `automatable: no`, or `manual`/`no` in a table's automatable column) are skipped. Cases tagged `(live)` or `@tag web` run only with `--include live` / `--include web`.
- **Steps overlay.** The same id in a later file adds that file's steps to the case. Keep product-owned case files untouched and put steps next to them: `vibe-testing cases test-cases.md test-cases.steps.md`. Title, priority and hint come from the first file.
- A JSON file holds `[{ "id", "title", "priority", "steps": [...] }]` with the same step objects as MCP `execute_scenario`.

## Steps

One command per line. Quote arguments with spaces (`"..."` or `'...'`). `#` starts a comment. `${NAME}` is replaced from the environment, so secrets stay out of the file.

| Command | Does |
|---|---|
| `open <url>` | Go to a URL, relative to the base URL |
| `fill <selector> <text>` | Type into a field |
| `click <selector>` | Click |
| `press <key> [selector]` | Press a key (`Enter`, `Tab`, `Escape`, `Shift+Tab`), on the focused element or on `selector` |
| `select <selector> <option>` | Pick a dropdown option |
| `upload <selector> <file>` | Set a file input |
| `wait <ms>` | Pause |
| `see <text>` / `see <selector> <text>` | The page (or element) shows the text |
| `visible <selector>` | The element is visible |
| `url <url>` | The current URL is exactly this |
| `in-viewport <selector>` | The element is fully inside the viewport, without scrolling (the fold check) |
| `no-horizontal-scroll` | The page does not scroll sideways |
| `still [ms] [ignore-selector]` | No animation is running, waiting up to `ms` (default 6000). Infinite animations fail it. |
| `eval <javascript>` | The expression is truthy in the page (`document.activeElement.id === 'email'`) |
| `a11y [critical\|serious\|moderate\|minor] [scope] [ignore=rule,rule]` | axe-core scan; violations at that impact or worse fail (default `serious`) |
| `request [--no-follow] <METHOD> <url> [json body]` | HTTP call with the browser's cookies (signed-in cases send the session). `--no-follow` keeps a redirect's own status |
| `header <name> <value>` | Send this header with later `request` steps (e.g. `Authorization "Bearer ${TOKEN}"`) |
| `status <spec>` | The last response's status: `200`, `2xx`, `400\|403`, `!5xx` |
| `json <path> [op] [value]` | Check the last JSON response (event-stream bodies, as from MCP servers, are read too) |

Selectors are CSS, or `text=`, `label=`, `placeholder=`, `role=button[name="Sign in"]`.

`json` paths: `a.b[0].c`, `items[*].id` (every item must pass), `$` for the whole body. Ops: `=` (default), `!=`, `contains`, `exists` (key present, may be null), `absent`, `length` (`3`, `>=1`), `matches` (regex), `>`, `>=`, `<`, `<=`. On an array of objects, `contains x` passes when an item has a field equal to `x` (`json result.tools contains brain_read`).

## Options

`@` lines in a case's block set options for that case; in a block before the first case they apply to the whole file.

| Option | Meaning |
|---|---|
| `@viewports 1440x900 390x844` | Run once per viewport (names: `desktop`, `laptop`, `tablet`, `phone`) |
| `@motion full reduce` | Run once with motion and once with `prefers-reduced-motion: reduce` |
| `@auth` / `@auth <account>` | Sign in first: `auth.storage_state` / `auth.cookies` if set, else `auth.credentials`; or the named entry of `auth.accounts`. One login per account per run. |
| `@public` | Signed out (overrides a file-level `@auth`) |
| `@base <url or folder>` | Base URL. A folder is relative to the markdown file and served over `file://`, so static design prototypes need no server |
| `@timeout <ms>` | Step timeout for this case |
| `@tag <tags>` | Tags; tagged cases need `--include <tag>` |
| `@skip <reason>` | Skip with a reason |

Every viewport x motion combination is one variant with its own screenshots. A case fails when any variant fails.

## Signing in without a form (OAuth)

When sign-in is Google or another OAuth provider, a test cannot complete it. Give the run a ready session instead, in `vibe.config.json`:

```json
{ "auth": { "storage_state": ".auth/owner.json" } }
{ "auth": { "cookies": [{ "name": "session", "value": "${TEST_SESSION_COOKIE}" }] } }
```

`storage_state` is a Playwright storage-state file (cookies and localStorage), for example saved once after signing in by hand with `npx playwright codegen --save-storage=.auth/owner.json <url>`. `cookies` suits apps whose test fixtures can mint a signed session cookie. `run` and `converge` use them too. CLI: `--storage-state <file>`.

## Outputs

Written to `.vibe/cases/` (or `--out`):

- `report.html`: one row per case with each variant's result and screenshot.
- `results.json`: cases, variants, steps, verification level and screenshot paths.
- `--junit <file>`: JUnit XML, one testcase per case and variant, for CI test reporters.
- `--ledger <file> --ledger-task <id>`: appends one JSON line per case: `{"ts","task","stage","kind":"vibe-run","ref":"TC-..","result":"pass|fail|warn","summary","path","sha","by"}`. Cases that did not run are `warn`, never `pass`. `--ledger-stage` (default `E4_vibe_test`), `--ledger-by` (default `agent:vibe-testing`), `--sha` (default: git HEAD of `--codebase`), `--ledger-path` (default: `report.html` relative to the ledger file's git repository).

Exit code 1 when a case fails or cannot run; with `--strict` also when a selected case needs steps. The report does not open by itself with `--no-open`, or when `CI` or `VIBE_NO_OPEN` is set.

Failing cases are retried `retries` times (config, default 1; `--retries 0` to turn off). A pass on a retry is marked "passed on retry" in the report and JSON.

## In GitHub Actions

```yaml
- run: npx playwright install --with-deps chromium
- run: npm start &            # your app
- run: npx -y vibe-testing@latest cases docs/test-cases/*.md --url http://localhost:3000 --junit vibe-junit.xml --no-open
- uses: actions/upload-artifact@v4
  if: always()
  with: { name: vibe-cases, path: .vibe/cases }
```

Point `--url` at a deployed preview the same way; the base URL can be any http(s) address.
