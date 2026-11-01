# Contributing

## Setup

No build step. Clone the repo and load it temporarily in Firefox:

1. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → select `manifest.json`.
2. Or `npx web-ext run` for auto-reload on file changes.

## Before opening a PR

```bash
npx web-ext lint
```

Must pass with no errors.

## Guidelines

- Keep `manifest_version: 2` — this is Firefox-only (Gecko), where MV2 is still fully supported; no need to port to MV3.
- Bump `version` in `manifest.json` for any user-facing change, following semver (`major.minor.patch`).
- Match existing code style (vanilla JS, no framework, no bundler).
- If you change what data is read/stored or add a permission, update `README.md`'s permissions table and `PRIVACY.md` in the same PR.

## Reporting issues

Open a GitHub issue with your Firefox version, OS, and steps to reproduce.
