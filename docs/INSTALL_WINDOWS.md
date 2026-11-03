# Installing F-list Workbench on Windows

Every release offers two builds of the same app:

- **The installer** (`F-list-Workbench-<version>-x64-Setup.exe`) is
  the main way to get the app. It installs for your Windows user only
  (no admin prompt), adds Start menu and desktop shortcuts, and
  **updates itself** from inside the app.
- **The portable exe** (`F-list-Workbench-<version>-x64-portable.exe`)
  runs from wherever you put it, with nothing to install. It does
  **not** update itself: it tells you when a new version exists and
  links to the release, and you download the new file yourself. It
  also unpacks itself to a temporary folder every time it starts, so it
  starts slower than the installed app.

Both keep your data in `%APPDATA%\flist-workbench\`, not next to the
program, so you can switch between them, move the portable exe, or
uninstall without losing your settings, characters or Backups.

## 1. Download

Open the
[Releases page](https://github.com/FoundryBlaise/flist-workbench/releases)
and grab one of:

- `F-list-Workbench-<version>-x64-Setup.exe` (installer, recommended)
- `F-list-Workbench-<version>-x64-portable.exe` (portable)

If you want to check that you got the file the maintainer actually
published, also grab `SHA256SUMS.txt` from the same release. See
**Optional: verify the download** below.

The release also lists `latest.yml` and a `.blockmap` file. Those are
for the installer's updater; you don't need to download them.

## 2. Install or run

**Installer:** run the Setup exe. It asks where to install (by default
a folder under `%LOCALAPPDATA%\Programs`) and offers to start the app
when it finishes.
From then on, launch it from the Start menu or the desktop shortcut.

**Portable:** put the exe anywhere (your Desktop, a folder in your
Documents, a USB stick) and double-click it.

## 3. First launch: SmartScreen will warn you

The first time you run the file you downloaded, Windows shows a blue
dialog:

> **Windows protected your PC**
> Microsoft Defender SmartScreen prevented an unrecognized app from
> starting. Running this app might put your PC at risk.
> *Don't run*

This is expected. It does **not** mean the file is malware. It means
the releases are **unsigned**: the files carry no Microsoft-recognised
code-signing certificate, so Windows cannot tell who published them.

Code-signing certificates cost a few hundred dollars a year per
publisher. F-list Workbench is a hobby project for a niche community;
paying that just so the dialog goes away isn't on the cards yet. Until
then, every release will trip this warning.

### To run the app anyway

1. In the SmartScreen dialog, click **More info** (small grey text
   under the message).
2. The dialog expands and now shows the app name and its publisher
   ("Unknown publisher", for the same reason).
3. Click **Run anyway** (now visible in the bottom right).

Each new file you download from the Releases page can show the
warning again; the same click-through applies.

### What if "Run anyway" isn't visible?

Some Windows installations (corporate / school / locked-down) hide
the **Run anyway** button entirely as a policy. If that's you, talk
to your IT admin: the app can't override that policy and you
shouldn't try to. A signed build is the only proper fix.

## 4. Updates

The app looks for a newer release once per launch, after your
character list has loaded, and whenever you pick **Help → Check for
Updates…**. Nothing downloads without asking.

- **Installer:** a card offers the new version. **Update** downloads
  it; **Restart** installs it and starts the new version. An update
  you downloaded but did not restart for installs when you quit the
  app.
- **Portable:** the card says a new version is available and links to
  its release page. Download the new portable exe there and use it in
  place of the old one.

The updater checks each download against the checksum listed in the
release's `latest.yml`. That catches a broken download; because the
releases are unsigned, it cannot prove who made the release.

## 5. Antivirus false positives

A small fraction of antivirus products flag unsigned PyInstaller-built
programs (the app ships a Python sidecar built that way) as
suspicious, even though they aren't. If your antivirus quarantines the
file:

- Confirm the file's sha256 matches `SHA256SUMS.txt` from the release.
- If it matches, the file is the one we published and the antivirus
  is wrong. Add a per-file exclusion in your antivirus settings, or
  report the false positive to the vendor.
- If it does **not** match, do not run the file. Open an issue.

## 6. What runs when you start the app

The app is two processes that run together:

- **F-list Workbench.exe**: the window you see
- **sidecar.exe**: a small local web server (Python) the window
  talks to over `127.0.0.1`

Both appear in Task Manager when the app is running. Both should
disappear when you close the window. If `sidecar.exe` lingers in
Task Manager after closing the window, that's a bug worth reporting.

The sidecar binds to port **27384** on loopback only. The app exposes
nothing to your network or to the internet: the sidecar isn't
reachable from outside your own machine.

That same port also serves a **Model Context Protocol** endpoint at
`/mcp`, which is how a model you connect (LM Studio, Claude) can read
and edit your characters through the app. It is loopback-only too, and
it rejects requests that don't come from your own machine. See
**Settings → MCP** in the app for the connection details.

## 7. Optional: verify the download

If you'd rather not trust GitHub's TLS alone, check that the sha256
hash of the file matches the line for the same file name in
`SHA256SUMS.txt`. From PowerShell, in the folder you downloaded to:

```powershell
Get-FileHash "F-list-Workbench-<version>-x64-Setup.exe" -Algorithm SHA256
Get-FileHash "F-list-Workbench-<version>-x64-portable.exe" -Algorithm SHA256
```

Run the line for the file you downloaded and compare the hex output
against `SHA256SUMS.txt`. They should match exactly (the case of the
letters doesn't matter). If they don't, delete the file and report it.

## 8. Where the app keeps your data

Nothing lives next to the program. Everything goes under
`%APPDATA%\flist-workbench\`:

- `characters/`: your characters: each one's Live (the profile as
  last pulled from F-list), its Workbench (your editable copy), its
  Backups (zips), images and Trash
- `foreign/`: a cache of other people's profiles you looked at
- `settings.db`: preferences (F-Chat log folder, embedding and
  reranker model, search tuning)
- `labels.db`: the IC/OOC Label of each Log message, partner aliases,
  and the keyword side of the search Index
- `qdrant/`: the search Index built by Logs → Ingest
- `models/`: the embedding and reranker models, downloaded the first
  time they are needed
- `avatars/`: cached character avatars
- `restore-state.json`: the paired browser extension's token
- `main-diag.log`: the window process's diagnostic log; safe to delete

## 9. Uninstalling

**Installer:** uninstall **F-list Workbench** from Windows Settings →
Apps, like any other program. That removes the program and keeps your
data.

**Portable:** delete the exe.

To remove your data as well, delete `%APPDATA%\flist-workbench\`.

## 10. Getting help

- Open an issue on the
  [repo](https://github.com/FoundryBlaise/flist-workbench/issues)
- If the app won't launch at all, check
  `%APPDATA%\flist-workbench\main-diag.log` for the error and attach
  the last few lines to your issue.
