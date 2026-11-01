# Publishing checklist

## 0. Prerequisites (one-time)

1. Node.js installed (for `web-ext`).
2. `npm install -g web-ext` (or use `npx web-ext`, no install needed).
3. A Firefox Account: https://accounts.firefox.com/
4. A developer account on AMO, created by visiting https://addons.mozilla.org/developers/ and signing in with that Firefox Account. You'll be asked to agree to the Developer Agreement.
5. (Recommended) Enable 2FA on the Firefox Account — Mozilla requires it for add-on developer accounts as of 2023.

## 1. GitHub repo

```bash
cd container-history
git init
git add .
git commit -m "Initial public release: Container History 1.0.0"
gh repo create Nirmal2OO8/container-history --public --source=. --remote=origin --push
```

(Or create the repo on github.com first, then `git remote add origin <url> && git push -u origin main`.)

The manifest's `browser_specific_settings.gecko.id` is `container-history@nirmal2oo8` and `homepage_url`/`developer.url` already point at `https://github.com/Nirmal2OO8/container-history` — make sure the repo you create matches that owner/name, or update `manifest.json` first.

Tag the release to match the version in `manifest.json`:

```bash
git tag v1.0.0
git push origin v1.0.0
```

## 2. Lint before you submit

AMO's automated review will reject obvious problems before a human ever looks at it. Catch them first:

```bash
npx web-ext lint --source-dir=.
```

Fix anything it flags (it checks manifest correctness, use of dangerous APIs, CSP issues, etc.) and re-run until clean.

## 3. Build the submission package

AMO wants a zip of the **source files**, not the signed `.xpi` (it builds/signs that itself):

```bash
npx web-ext build --source-dir=. --artifacts-dir=web-ext-artifacts
```

This produces `web-ext-artifacts/container_history-1.0.0.zip`. That's the file you upload.

## 4. Submit on AMO

1. Go to https://addons.mozilla.org/developers/addon/submit/distribution
2. Choose distribution method:
   - **On this site (listed)** — public AMO listing, searchable, auto-updates via AMO. Recommended for a normal public release.
   - **On your own (unlisted)** — Mozilla still signs it (required for Firefox to load it permanently) but it won't be listed or searchable; you distribute the `.xpi` yourself (e.g. a GitHub release).
3. Upload the zip from step 3.
4. Select channel: **Firefox** (not Android, unless you also want it there — nothing in this extension is mobile-specific, but test it on Firefox for Android first if you check that box).
5. Automated validation runs immediately. If it fails, fix and re-upload.

## 5. Fill in the listing (listed distribution only)

AMO will prompt for:
- **Name / summary / description** — use `store-listing/description.txt` in this repo as a starting draft.
- **Categories** — "Privacy & Security" and/or "Tabs" fit best.
- **Icon** — pulled from the manifest automatically, but you can also upload a dedicated 128×128 store icon if you want it to differ from the toolbar icon (see the icon section of this task for ideas).
- **Screenshots** — at least one is required for listed add-ons. Use the popup itself (open the extension, take a screenshot of a few history entries with containers visible). Put source images in `screenshots/`.
- **Privacy policy** — because this extension requests `history` and `cookies` permissions, AMO will ask whether it collects/transmits user data and may require a privacy policy link. Point it at `PRIVACY.md` once the repo is public, e.g. `https://github.com/Nirmal2OO8/container-history/blob/main/PRIVACY.md`, or paste its contents into AMO's privacy policy field.
- **Support email / homepage URL** — homepage already set to the GitHub repo in the manifest.
- **License** — select MIT to match `LICENSE`.

## 6. Review

- Listed add-ons go through automated validation immediately, then (depending on permissions and flags) may get a manual review. Extensions requesting `history`/`cookies` are routinely manually reviewed — expect it to take anywhere from a few hours to a couple of weeks.
- Unlisted add-ons are typically auto-signed within minutes to hours if validation passes, with lighter manual review.
- You'll get email notifications at each stage; check the "Status & Versions" tab on the add-on's developer page for logs if anything is rejected.

## 7. After approval

- Listed: the add-on gets a permanent AMO URL (`https://addons.mozilla.org/firefox/addon/container-history/` or similar, AMO may append a suffix if the slug is taken). Add that URL to the README's Installation section and to the GitHub repo's "About" link.
- Unlisted: download the signed `.xpi` from the developer dashboard and attach it to a GitHub Release (`gh release create v1.0.0 path/to/container_history-1.0.0.xpi`).

## 8. Future updates

Bump `version` in `manifest.json` (AMO requires every upload to have a version strictly greater than the last), re-run `web-ext lint` and `web-ext build`, and upload a new version from the same add-on's "Upload New Version" page — you do not resubmit as a new listing.
