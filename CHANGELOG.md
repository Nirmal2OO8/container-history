# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/).

## 1.0.0 — First public release
- Records the container each visited URL was opened in, and reopens it correctly.
- Browse, search, and filter full history by container; sort by recency, visit count, or domain.
- Right-click "Open in Original Container" context menu entry.
- Keyboard shortcut (`Ctrl+Shift+H` / `MacCtrl+Shift+H`), keyboard navigation, and per-row actions
  (open in a different container, set a remembered container, forget a record, delete from history).
- All data stored locally via `browser.storage.local`; no network requests.
