# Privacy Policy

**Container History** does not collect, transmit, or sell any data to the developer, Mozilla, or any third party.

## What the extension stores

To do its job, the extension reads data Firefox already has and keeps a local record of it:

- The URL, container (cookie store) name/color/icon, and visit timestamp for pages you browse, via the `history` and `contextualIdentities` permissions.
- This map is written to `browser.storage.local` (the `storage` permission) — a local, per-profile database managed by Firefox itself.

## What it does not do

- It makes no network requests. There is no analytics, telemetry, or remote server involved.
- Nothing is synced, uploaded, or shared with the developer or any third party.
- No data leaves your device.

## Data retention and removal

- The stored map is capped at 10,000 entries; older automatically-recorded entries are evicted first.
- Uninstalling the extension removes its local storage along with it.
- You can also clear the extension's data manually at any time via `about:addons` → Container History → "Clear Data", or by clearing your Firefox profile's extension storage.

## Permissions summary

See the [README](README.md#permissions) for what each requested permission is used for and why.

## Contact

Questions about this policy: open an issue at https://github.com/Nirmal2OO8/container-history/issues.
