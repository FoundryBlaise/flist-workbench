# Installing F-list Workbench on Windows

Workbench ships as a single **portable .exe** — there's no installer.
Drop it anywhere (your Desktop, a folder in your Documents, a USB
stick), double-click, and you're running. The app keeps its data
under `%APPDATA%\flist-workbench\`, not next to the .exe, so you can
move or delete the binary without losing your settings, working
copies, or backups.

## 1. Download

Grab `F-list Workbench-<version>-x64-portable.exe` from the
[Releases page](https://github.com/FoundryBlaise/flist-workbench/releases).

If you care about verifying you got the file the maintainer actually
published, also grab `SHA256SUMS.txt` from the same release. See
**Optional: verify the download** below.

## 2. First launch — SmartScreen will warn you

The first time you double-click the .exe, Windows shows a blue
dialog:

> **Windows protected your PC**
> Microsoft Defender SmartScreen prevented an unrecognized app from
> starting. Running this app might put your PC at risk.
> *Don't run*

This is expected. It does **not** mean the file is malware. It
means the binary isn't signed with a Microsoft-recognised code-signing
certificate.

Code-signing certificates cost a few hundred dollars a year per
publisher. Workbench is a hobby project for a niche community; paying
that just so the dialog goes away isn't on the cards yet. Until then,
every Workbench release will trip this warning.

### To run the app anyway

1. In the SmartScreen dialog, click **More info** (small grey text
   under the message).
2. The dialog expands and now shows the app name + publisher
   ("Unknown publisher" — same reason).
3. Click **Run anyway** (now visible in the bottom right).

You only have to do this **once per version**. Windows remembers your
choice for that specific file. When you upgrade to the next release
you'll see the warning again — same click-through.

### What if "Run anyway" isn't visible?

Some Windows installations (corporate / school / locked-down) hide
the **Run anyway** button entirely as a policy. If that's you, talk
to your IT admin — Workbench can't override that policy and you
shouldn't try to. A signed build is the only proper fix.

## 3. Antivirus false positives

A small fraction of antivirus products flag unsigned PyInstaller-built
binaries (Workbench bundles a Python sidecar that way) as suspicious,
even though they aren't. If your AV quarantines the .exe:

- Confirm the file's sha256 matches `SHA256SUMS.txt` from the release.
- If it matches, the file is the one we published — the AV is wrong.
  Add a per-file exclusion in your AV settings, or report the false
  positive to the AV vendor.
- If it does **not** match, do not run the file. Open an issue.

## 4. What launches when you double-click

Workbench is two processes that run together:

- **F-list Workbench.exe** — the window you see
- **sidecar.exe** — a small local web server (Python) the window
  talks to over `127.0.0.1`

Both appear in Task Manager when the app is running. Both should
disappear when you close the window. If `sidecar.exe` lingers in
Task Manager after closing the window, that's a bug worth reporting.

The sidecar binds to port **27384** on loopback only. Nothing is
exposed to your network or to the internet by Workbench itself —
the sidecar isn't reachable from outside your own machine.

## 5. Optional: verify the download

If you'd rather not trust GitHub's TLS alone, verify the sha256 hash
of the .exe matches what's in `SHA256SUMS.txt`. From PowerShell:

```powershell
Get-FileHash "F-list Workbench-<version>-x64-portable.exe" -Algorithm SHA256
```

Compare the hex output against the line for the same filename in
`SHA256SUMS.txt`. They should match exactly. If they don't, delete
the file and report it.

## 6. Where Workbench keeps your data

Nothing lives next to the .exe. Everything goes under
`%APPDATA%\flist-workbench\`:

- `documents.db` — your scratch document + saved BBCode docs
- `characters/` — character archive working copies + backups
- `logs/` — F-Chat log index (if you point Settings → F-Chat data
  directory at your real F-Chat folder)
- `main-diag.log` — main-process diagnostic log; safe to delete
- `settings/` — preferences, paired browser extensions, etc.

To completely uninstall: delete the .exe, then delete
`%APPDATA%\flist-workbench\`. That's it.

## 7. Getting help

- Open an issue on the
  [repo](https://github.com/FoundryBlaise/flist-workbench/issues)
- If the app won't launch at all, check
  `%APPDATA%\flist-workbench\main-diag.log` for the stack trace and
  attach the last few lines to your issue.
