# npx entrypoint design

## Problem

The documented command `npx vibe-testing@latest init` cannot select an executable from the package manifest. The package publishes two different binaries, `vibe-test` and `vibe-test-mcp`, and neither matches the unscoped package name `vibe-testing`.

## Design

Add `vibe-testing` as an alias for `dist/cli.js`. Keep both existing binary names unchanged so current CLI users and MCP configurations continue to work.

Protect the contract with a package metadata test. The test reads `package.json` and requires the package-name binary to point at the same CLI file as `vibe-test`. Release verification packs the package, installs it in a temporary project, runs `npx --no-install vibe-testing --version`, and checks the existing `vibe-test` and `vibe-test-mcp` links remain present.

## Release

Date the existing 0.4.3 changelog entry and record the executable alias. After tests, build, and tarball checks pass, commit and push the branch. The final release action is tag `v0.4.3`; the existing GitHub workflow publishes npm first and the MCP Registry second through trusted publishing.

## Boundaries

No CLI behavior, MCP protocol behavior, dependency version, or documentation command changes are required. The release must not use the local unpublished build as evidence that the registry command works.
