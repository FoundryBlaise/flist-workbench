# Packaging F-list Workbench for Windows

> **Status:** Implemented 2026-05-24. Phase 8 tail (SmartScreen
> click-through guide → `docs/INSTALL_WINDOWS.md`, renderer CSP →
> `renderer/index.html`, tag-triggered release workflow →
> `.github/workflows/release.yml`) shipped 2026-06-17.
>
> The repo now contains a working Windows pack pipeline. To rebuild
> the portable .exe:
>
> ```cmd
> npm run pack:win
> ```
>
> That runs three things in order:
> 1. `electron-vite build` — bundles main / preload / renderer into `out/`
> 2. `npm run pack:sidecar` — PyInstaller bundles `sidecar/` into
>    `resources/sidecar.exe` (one-file, windowed/no-console)
> 3. `electron-builder --win` — wraps the lot into a single portable
>    .exe at `dist-electron/F-list Workbench-0.0.0-x64-portable.exe`
>
> Output size: ~90 MB. No installer, no Python required on the target
> machine, double-click to run. First launch shows a SmartScreen
> "unrecognized app" warning (unsigned binary) — click "More info" →
> "Run anyway."
>
> **Prereqs on the build machine:** Node 22+, Python 3.12+, `uv` on
> `PATH`, and a one-time `uv sync` inside `sidecar/` to create the venv
> that `pack:sidecar` invokes PyInstaller from.
>
> **Default port:** sidecar binds **27384** in both dev and packaged
> builds. Picked in the upper-20k range so it doesn't fight with the
> cluster of common dev-tool ports around :8xxx. The browser extension
> hardcodes the same number — keep them aligned if you ever move it.
> `SIDECAR_PORT` env var still overrides at runtime.
>
> The rest of this doc is the original implementation spec, kept for
> reference. The "Things that will probably bite you" section near the
> bottom is still worth a read before changing the pipeline.

---

## What you're packaging

This is an Electron desktop app with a Python sidecar. Architecture:

```
┌────────────────────────────────────────────┐
│ Electron main process (electron/main.ts)   │
│  ├─ spawns Python sidecar on startup       │
│  └─ creates the BrowserWindow              │
│                                            │
│ Renderer (React + Vite, renderer/src/)     │
│  └─ talks to sidecar over HTTP at :27384    │
│                                            │
│ Sidecar (FastAPI, sidecar/)                │
│  ├─ /health, /profile/{name}               │
│  ├─ /logs/* (characters, partners, search) │
│  ├─ /documents/* (SQLite-backed library)   │
│  └─ /settings (FCHAT_DATA_DIR override)    │
└────────────────────────────────────────────┘
```

The packaging job is to take this and produce a `.exe` a normal
Windows user can double-click to install — no Python install required.

**Out of scope** (do not bundle):
- LLM weights (the RAG features in `docs/PLAN.md` Phase 5 aren't shipped
  yet — anything that talks to LM Studio expects the user to run it on
  the host)
- Anything from `/sideprojects/rag/data` — that's the maintainer's
  personal RP corpus, not redistributable
- Sample/test profile fixtures (`sidecar/tests/fixtures/`,
  `renderer/src/lib/bbcode/__fixtures__/`) — fine to leave in source
  but don't extra-bundle them into the installer

---

## Prerequisites on your Windows machine

You need all of these installed and on `PATH`:

- **Node 22 LTS or newer** (`node --version` should print v22.x)
- **Python 3.12** (`python --version`). The sidecar was developed on
  3.12; later 3.x may work but isn't tested.
- **Git** for cloning the repo
- A working **MSBuild / Visual Studio C++ build tools** install if any
  Electron native deps need rebuilding. The current deps don't (pure
  JS + a single Python file), but `electron-builder` may complain
  without it.

You do NOT need Wine, Docker, or WSL.

---

## Get the source

```cmd
git clone git@github.com:FoundryBlaise/flist-workbench.git
cd flist-workbench
git checkout dev
git pull
```

There's an SSH key setup expected; the maintainer can give you HTTPS
if SSH isn't available.

Then install the existing JS deps:

```cmd
npm install
```

And the Python deps (the maintainer uses `uv`, which is fine on
Windows too):

```cmd
cd sidecar
pip install uv
uv sync
cd ..
```

Sanity check — these should both pass before you start packaging:

```cmd
npm run build
npm run test
cd sidecar
uv run pytest
cd ..
```

If any of those fail, fix that first — packaging on top of a broken
build will waste your time. The dev branch should be green; if it
isn't, that's a maintainer problem, not yours.

---

## The plan

Three things have to fall into place for the .exe to work:

1. **Python sidecar → standalone binary.** Use PyInstaller to bake the
   sidecar (FastAPI app + parser + documents store) into a single
   `sidecar.exe` that needs nothing else on the user's machine.
2. **Electron → packaged app.** Use `electron-builder` to produce an
   NSIS installer that ships the Electron app plus the sidecar binary.
3. **Wiring.** `electron/sidecar.ts` already has a packaged-vs-dev
   branch — flip the packaged branch to spawn the bundled binary
   instead of `python -m uvicorn`.

Do these in order — each step is independently verifiable.

---

## Step 1 — PyInstaller the sidecar

From the repo root:

```cmd
cd sidecar
uv pip install pyinstaller
uv run pyinstaller --onefile --name sidecar server.py --hidden-import uvicorn.logging --hidden-import uvicorn.loops --hidden-import uvicorn.loops.auto --hidden-import uvicorn.protocols --hidden-import uvicorn.protocols.http --hidden-import uvicorn.protocols.http.auto --hidden-import uvicorn.protocols.websockets --hidden-import uvicorn.protocols.websockets.auto --hidden-import uvicorn.lifespan --hidden-import uvicorn.lifespan.on
```

The hidden-import salad is real — uvicorn lazily resolves its loop
and protocol implementations via `importlib`, and PyInstaller can't
follow that without help. If you skip them the binary starts but
crashes the moment a request hits a websocket-capable endpoint.

That produces `sidecar/dist/sidecar.exe`. Verify it runs standalone:

```cmd
cd dist
sidecar.exe
```

Hit `http://127.0.0.1:27384/health` in a browser — should return
`{"status":"ok","version":"0.0.0"}`. Stop it with Ctrl+C.

**Common PyInstaller gotchas you'll hit:**

- `parser.py` uses `struct` — fine, stdlib.
- `documents.py` and `settings.py` use `sqlite3` — fine, stdlib, but
  the bundled sqlite has its own quirks. Run the full test suite
  against the *binary* before shipping (see Step 5).
- The sidecar opens `documents.db` in the user-data dir at runtime.
  That dir is resolved at runtime, NOT at bundle time. Don't try to
  bake a fixed path.

If PyInstaller misses an import, add another `--hidden-import` and
rebuild. The full list above was extracted from a few cycles of "run
it, see what crashes." Expect to add 1-2 more.

Once it works, **move the binary into `resources/`** (create the
directory at the repo root):

```cmd
mkdir resources
move sidecar\dist\sidecar.exe resources\sidecar.exe
```

`resources/` is where electron-builder will pick it up.

---

## Step 2 — Wire the packaged branch

Open `electron/sidecar.ts`. The dev branch already works — it spawns
`uv run uvicorn server:app` from `sidecar/`. The packaged branch
currently assumes `python` is on PATH, which is wrong for a real
user. Replace it.

Look for this block:

```ts
const cmd = app.isPackaged ? 'python' : 'uv'
const args = app.isPackaged
  ? ['-m', 'uvicorn', 'server:app', '--port', String(PORT)]
  : ['run', 'uvicorn', 'server:app', '--port', String(PORT)]
```

Change to:

```ts
const cmd = app.isPackaged
  ? join(process.resourcesPath, 'sidecar.exe')
  : 'uv'
const args = app.isPackaged
  ? ['--port', String(PORT)]
  : ['run', 'uvicorn', 'server:app', '--port', String(PORT)]
```

Note: PyInstaller-bundled FastAPI/uvicorn apps don't accept the
`server:app` argument — the binary is the entire process. Pass the
port via a CLI flag or env var instead. The cleanest move is:

1. Add `--port` parsing to the sidecar's startup in `sidecar/server.py`
   (use `os.environ.get("SIDECAR_PORT")` — the env var is already set
   by `electron/sidecar.ts`).
2. Wrap `app` in a `if __name__ == "__main__":` block in `server.py`
   that calls `uvicorn.run(app, host="127.0.0.1", port=...)`. Then
   PyInstaller has a real entry point.

Pseudo-code for `server.py`'s bottom:

```python
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("SIDECAR_PORT", "27384"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
```

After that, the packaged-branch spawn becomes just `sidecar.exe` with
no args — the env var carries the port.

Verify by running `npm run build` and pretending you're packaged
(`app.isPackaged` is false in dev, so you can't test this branch
locally without electron-builder — that's Step 4).

---

## Step 3 — Install electron-builder

```cmd
npm install --save-dev electron-builder
```

This is a big dep — installs `app-builder`, several signing tools,
icon bundlers, etc. Expect 200+ MB in `node_modules`.

---

## Step 4 — electron-builder config

Create `electron-builder.yml` at the repo root:

```yaml
appId: net.aiart-foundry.flist-workbench
productName: F-list Workbench
copyright: Copyright (c) 2026 Foundry Blaise
directories:
  output: dist-electron
  buildResources: build-resources
# Files from the repo that ship inside the .asar. Keep this tight —
# the dev sidecar source, tests, sample fixtures, and screenshots
# don't belong in a release build.
files:
  - out/**/*
  - package.json
  - "!**/*.map"
  - "!**/node_modules/**/{test,__tests__,tests}/**"
extraResources:
  # Ships next to the .asar, accessible via process.resourcesPath.
  # electron/sidecar.ts spawns this when app.isPackaged is true.
  - from: resources/sidecar.exe
    to: sidecar.exe
asar: true
win:
  target:
    - target: nsis
      arch: [x64]
    - target: portable
      arch: [x64]
  artifactName: ${productName}-${version}-${arch}.${ext}
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
```

A few things to call out:

- `appId` is a reverse-DNS identifier — set to
  `net.aiart-foundry.flist-workbench` (matches the persona's email
  domain). Don't change without checking with the maintainer.
- `copyright` and any UI strings should say **Foundry Blaise**, never
  any other name. See the identity rule below.
- `oneClick: false` — gives the user the "where to install" dialog.
  Default `true` silently installs to `%LOCALAPPDATA%`, which is
  surprising on a fresh app.
- We're producing both `nsis` (proper installer) and `portable`
  (single .exe, no install). Pick one if you only need one — portable
  is friendlier for casual testing, nsis is what users will expect.

---

## Step 5 — npm scripts

Edit `package.json` `"scripts"`:

```json
"scripts": {
  "dev": "electron-vite dev",
  "build": "electron-vite build",
  "preview": "electron-vite preview",
  "typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json",
  "lint": "eslint .",
  "format": "prettier --write .",
  "test": "vitest run",
  "test:e2e": "playwright test",

  "pack:sidecar": "cd sidecar && uv run pyinstaller --noconfirm sidecar.spec",
  "pack:win": "npm run build && npm run pack:sidecar && electron-builder --win"
}
```

And save the PyInstaller invocation from Step 1 into a spec file at
`sidecar/sidecar.spec` so the npm script is one command. The first
run from Step 1 generates a spec file in `sidecar/sidecar.spec` —
edit it to set `name='sidecar'` and the hidden-imports list, then the
npm script just re-runs it.

---

## Step 6 — Build it

```cmd
npm run pack:win
```

This will:

1. Build the renderer + electron-main with electron-vite
2. PyInstaller the sidecar to `resources/sidecar.exe`
3. electron-builder wraps it all into installers under `dist-electron/`

Expected output:

```
dist-electron/F-list Workbench-0.0.0-x64.exe         (nsis installer)
dist-electron/F-list Workbench-0.0.0-x64-portable.exe (portable)
dist-electron/win-unpacked/                          (raw, for debugging)
```

If electron-builder errors out:
- `cannot find module …` → the missing module needs to be in
  `dependencies` (not `devDependencies`) in `package.json`. Move it
  and rebuild.
- Code-signing complaints → ignore for now, you don't have a
  certificate. We'll ship unsigned for the first test build. The
  user will see a SmartScreen warning on first launch; that's
  expected.

---

## Smoke test the produced .exe

This is the part nobody does and then ships a broken build. **Do not
skip it.** Install from `dist-electron/F-list Workbench-...nsis.exe`
on a clean Windows VM if you have one; otherwise install on your dev
machine but uninstall afterwards.

Checklist (in order — each step depends on the previous one working):

- [ ] **Launches** — double-click the shortcut, the window opens
- [ ] **Sidecar status pill is green** ("sidecar: ok") within 5 seconds.
      If it goes red, the bundled sidecar.exe isn't spawning. Open
      DevTools (Ctrl+Shift+I), check the Console for the spawn error,
      and look at the Task Manager — there should be a `sidecar.exe`
      process running alongside `F-list Workbench.exe`.
- [ ] **Editor loads** with the sample BBCode pre-populated in the
      Scratch document (the seed text from `sidecar/documents.py`)
- [ ] **Preview renders** the sample on the right side
- [ ] **Ctrl+B / I / U / K** wrap selected text in the editor
- [ ] **Fetch profile** with "Azure Viper" succeeds — requires internet
      and that the bundled sidecar can reach f-list.net. This is the
      most likely failure: TLS cert handling, the bundled `httpx`
      / `certifi` may be missing CA bundles. If it fails, run
      `sidecar.exe` standalone from `resources/` and `curl
      http://127.0.0.1:27384/profile/Azure%20Viper` to see the error
- [ ] **Settings… opens** (title-bar button)
- [ ] **Settings → Browse…** opens the OS folder picker
- [ ] Set Settings to a folder containing a few F-Chat character
      directories (or create a fake one — empty `<dir>/SomeChar/logs`
      is enough). Hit Save. The sidebar should refresh and list
      "SomeChar".
- [ ] **Find contacts…** opens, typing into the input works (this was
      a regression once — it must still work in the packaged build),
      Find returns either results or "no DM logs"
- [ ] **Save / History** — make an edit in the editor, click Save,
      then History, see the revision appear with timestamp
- [ ] **Logs mode** — pick a character with logs in the dir you
      configured, open a partner, see messages render
- [ ] **App closes cleanly** — File menu / close window. Task Manager:
      both `F-list Workbench.exe` and `sidecar.exe` should be gone.
      If sidecar.exe lingers, the cleanup in `electron/main.ts`'s
      `before-quit` handler isn't firing — flag this back.

If any of these fail, document what failed and report back rather
than working around it. A half-working build is worse than no build.

---

## Identity rule — critical, please read

This is a roleplaying community. The maintainer's real-world identity
**must not** appear in:

- Commit messages
- File headers, code comments
- LICENSE, package.json `author`, electron-builder `copyright`
- Screenshots in docs
- Installer text, "About" dialogs, anywhere the user sees

The project persona is **Foundry Blaise** (`blaise@aiart-foundry.com`).
That's the only name that should appear in any of those places. The
GitHub account is `FoundryBlaise`. Repo git config is already set;
don't override it.

If you find anything that exposes a different name, flag it back to
the maintainer immediately — do not commit it.

---

## Commit / push rules

- Commit your work. The maintainer wants to see the diffs.
- Push to `dev` is pre-approved. Do not push to `main` without
  asking. Do not force-push anywhere.
- Use `git add <file>` rather than `git add -A` to avoid sweeping
  in `resources/sidecar.exe` (a 30-40 MB binary), `dist-electron/`,
  or the PyInstaller `build/` and `__pycache__/` directories. Add
  those to `.gitignore` if they're not already.
- Co-author trailer is fine and expected:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

Suggested commit shape (one is fine, but feel free to split):

```
Phase 6 — Windows packaging (electron-builder + PyInstaller sidecar)

- electron-builder.yml with nsis + portable targets
- pack:sidecar npm script wrapping PyInstaller
- pack:win driver script
- electron/sidecar.ts packaged-branch spawns bundled sidecar.exe
- server.py gains __main__ block so PyInstaller has a real entry point
- .gitignore for dist-electron/, build/, resources/sidecar.exe
- Tested with the full smoke checklist in docs/PACKAGING_WINDOWS.md
```

---

## Things that will probably bite you

- **TLS / CA bundle** for httpx in the packaged sidecar. If
  `/profile/Azure Viper` fails with a cert error, you need to bundle
  `certifi`'s `cacert.pem` and set `SSL_CERT_FILE` to point at it in
  the packaged binary's startup. PyInstaller's `--collect-data
  certifi` flag handles this.

- **First-launch sidecar startup time.** PyInstaller-bundled apps
  unpack themselves on every launch (the `_MEIPASS` temp dir). On
  cold boot from a slow disk this can take 2-3 seconds. The
  `waitForHealth` timeout in `electron/sidecar.ts` is 30 seconds so
  this is fine, but expect a brief delay before the green "sidecar:
  ok" pill.

- **Antivirus false positives.** Unsigned PyInstaller binaries get
  flagged by Windows Defender SmartScreen on first launch. Tell the
  test user to click "More info" → "Run anyway." Real users get a
  proper code-signing cert later.

- **Sidecar can't write documents.db.** The packaged sidecar writes
  to `%APPDATA%\flist-workbench\documents.db`. This dir is created
  on demand by `documents.user_data_dir()`. If permissions are weird
  on the test machine (corporate AD, locked-down profile), the
  sidecar will return 500 errors when the renderer asks for
  `/documents`. Test on a normal user account.

- **Sidecar's bundled SQLite vs Python's bundled SQLite.** PyInstaller
  ships its own sqlite3 stdlib module. It's usually current enough
  for our usage (no FTS5 yet), but if you hit "no such function" /
  "no such table" errors after a successful first launch, that's
  the likely cause.

---

## When you're done

Drop the produced `.exe` file and a copy of this checklist back to
the maintainer with:

- Path to the installer in `dist-electron/`
- The smoke-test checklist with [x] / [ ] marked
- Any deviations from this doc you had to make and why
- Any hidden-imports you added beyond the list in Step 1

That's it. Good luck.
