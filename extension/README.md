# F-list Workbench Browser Extension

Browser extension that lets you restore F-list character backups from
[F-list Workbench](https://github.com/FoundryBlaise/flist-workbench) directly
on the F-list character edit page. Also imports from local ZIP files
exported by Workbench or the legacy userscript.

**This extension never clicks Save for you.** It fills the form, scrolls
to F-list's own Save button, and stops. You review every field and click
Save yourself.

## How it works

1. Sign in to F-list normally in your browser. Open
   `https://www.f-list.net/character_edit.php?character=<name>`.
2. The extension injects an **F-list Workbench** bar at the top of the
   edit form with two buttons:
   - **Import from Workbench** — lists working copy + backup snapshots
     stored in your local Workbench app; pick one, get a safety screen,
     then Apply.
   - **Import from ZIP file** — load a Workbench-exported `.zip` from
     disk (also reads the legacy userscript's `.zip` format).
3. The safety screen tells you exactly what's about to change. Image
   add/remove operations happen **immediately** on Apply because F-list's
   image API does not wait for Save. Form fields (description, kinks,
   infotags, settings, custom kinks) only persist when you click Save.
4. On Apply: form is filled, gallery is synced (if you didn't skip
   images), page scrolls to F-list's Save button. You click Save.

## Pairing

The extension talks to Workbench's local sidecar at `127.0.0.1:27384`
using a per-install auth token. First use:

1. Start the F-list Workbench app.
2. Click the extension's toolbar icon → **Pair with Workbench**.
3. Workbench shows an Accept-this-extension modal. Click **Accept**.

The token is stored in the extension and persists across browser
restarts. You can rotate or revoke it from Workbench: **Settings →
Security → Rotate pairing token**, or from this popup → **Unpair**.

The token only authorizes reading backup snapshots and posting a
form-state snapshot — it does not let any party drive your F-list
session. F-list cookies stay in your normal browser, untouched.

## Install (Chrome / Chromium / Edge — Developer mode)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. **Load unpacked** → pick this folder (`FlistCharExporter/`).
4. Pin the extension to the toolbar for easy pairing.

## Install (Firefox — unsigned, temporary)

1. Open `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…** → pick `manifest.json` in this folder.
3. The temp install persists until Firefox restarts; signed XPI
   distribution is the long-term path.

A signed `.xpi` for permanent install on Firefox release is forthcoming.

## What gets restored

| Category | Behavior |
| --- | --- |
| Description, custom title | Filled in the form, persists on Save |
| Settings (public, timezone, etc.) | Filled in the form, persists on Save |
| Infotags (profile fields) | Filled in the form, persists on Save |
| Kinks (fetish preferences) | Filled in the form, persists on Save |
| Custom kinks | Filled in the form, persists on Save |
| Avatar | Uploaded immediately (not gated by Save) |
| Gallery images | Deleted/uploaded immediately (not gated by Save) |

**Skip image changes** in the safety screen if you only want the form
fields touched.

## "Back up first" option

Before applying a restore, you can click **Back up current state first**.
The extension extracts the current form contents and POSTs them to
Workbench as a backup snapshot.

v1 limitation: this snapshot does not include image bytes. If you need
a full image backup before restoring, do that from Workbench itself
(Pull → Backup) first.

## Legacy userscript

The original `flist-character-exporter.user.js` userscript remains
supported and lives in this same repo for hot-fix purposes when F-list
breaks form selectors and the extension's review/release queue is slow.

See [USERSCRIPT.md](USERSCRIPT.md) for the userscript install + usage
docs. Running both at once works but injects two sets of buttons on the
edit page — pick one.

## Privacy

This extension:

- Runs only on `https://www.f-list.net/character_edit.php*`.
- Talks to `http://127.0.0.1:27384` (your local Workbench sidecar).
- Talks to `https://static.f-list.net/*` for image bytes during the
  restore.
- Stores only the Workbench pairing token in `chrome.storage.local`.
- Does not contact any other server, log analytics, or hold an F-list
  session.

## License

MIT — see [LICENSE.md](LICENSE.md) (forthcoming) or, for the bundled
JSZip library, see [vendor/jszip-LICENSE.md](vendor/jszip-LICENSE.md).
