# vibe-testing launch site design

## Job

Give AI-assisted developers enough evidence to install vibe-testing and run one release check. The page should answer three questions in order: what changed, what evidence exists, and how do I run it in my project?

## Identity

The page uses the visual language of a senior QA control room: a release dossier, a regression ledger, compact status labels, route-level evidence, and one decisive release verdict. It avoids generic SaaS cards, decorative gradients, fake customer logos, and unsupported performance claims.

The signature element is an interactive regression ledger in the opening viewport. Switching between the current run and the previous run changes the release verdict and exposes the exact route that regressed. The example is labeled as an example report and uses fields the product actually emits: `snapshot_diff`, route status, verification status, duration, console errors, API observations, and screenshot evidence.

## Visual system

- Background `#F3F0E8` resembles a working QA document rather than a dark developer dashboard.
- Ink `#171914`, muted ink `#62665C`, rule `#C8C4B8`, pass `#167B53`, fail `#C33A2C`, and evidence blue `#2457D6` carry semantic meaning.
- Instrument Serif provides the editorial display voice. IBM Plex Mono handles evidence, commands, and labels. Inter is the body face.
- The layout is a ruled dossier with a narrow status rail and a wide evidence panel. Mobile collapses to one column without hiding evidence.

## Page structure

1. Navigation with npm, GitHub, and install action.
2. Opening dossier with the product claim, copyable install command, release verdict, and interactive regression evidence.
3. A report excerpt showing failures, outcome verification, API status, and coverage gaps.
4. A comparison explaining what code awareness, memory, and thirteen tools add to browser automation.
5. The thirteen tools grouped by testing job.
6. Setup paths for CLI, MCP, and Agent Plugin.
7. First-user invitation that opens a prefilled GitHub issue and emits an analytics event.
8. Marketplace and repository links.

## Interaction and analytics

Every acquisition action has a stable `data-event` name. `site/app.js` dispatches a `vibe:analytics` browser event, records aggregate counts in local storage, and optionally sends JSON to an endpoint declared by `meta[name="analytics-endpoint"]`. This gives a future analytics service a clean integration point without adding trackers or requiring an account now.

The install command copies with explicit feedback. The report switcher is keyboard accessible. Motion is limited to a short verdict transition and disabled by `prefers-reduced-motion`.

## Deployment

The site is plain HTML, CSS, and JavaScript under `site/`. A GitHub Actions workflow publishes that folder to GitHub Pages. The package build and npm release process remain unchanged.

## Distribution

`docs/distribution/` contains exact listing copy, install commands, asset references, submission URLs, and account-dependent steps for Cursor, Claude, Smithery, PulseMCP, and mcp.so. GitHub-based submissions may be opened when the target accepts them and the repository meets its published requirements.

