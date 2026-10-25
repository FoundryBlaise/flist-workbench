# Mutation probe

The mutation probe measures how strong the tests are. It injects one small,
realistic bug at a time (a mutation), runs the tests that should notice,
records whether they did, and puts the source back. A mutation the tests
catch is **killed**; one they miss **survived**. Run it after each cleanup
spec to see whether test strength went up or down.

- Tool: `scripts/mutation_probe/probe.py` (Python 3.11+, standard library only)
- Mutation list: `scripts/mutation_probe/mutations.toml`
- Results of past runs: `docs/mutation-probe/`

## Running it

From a clean checkout (commit or remove local changes first; the probe
refuses a dirty tree, untracked files included):

```
sidecar\.venv\Scripts\python.exe scripts\mutation_probe\probe.py --report docs\mutation-probe\<date>-<what>.md
```

The sidecar tests run with `sidecar/.venv` (or `--python <exe>`, or
`$PROBE_PYTHON`); the renderer tests run with `npx vitest`, so
`node_modules` must exist. In a git worktree, which has neither, pass
`--python` pointing at the main checkout's venv and link `node_modules`
as a junction to the main checkout's.

A full run of all 58 mutations takes about 30 minutes, most of it the
sidecar mutations that survive (a survivor runs every listed test, about
100 s each; a kill stops at the first failure). Renderer mutations take
a few seconds each.

Useful options:

| Option | Effect |
| --- | --- |
| `--check` | Only check that every mutation's find text still occurs exactly once. Fast; run it after refactoring. |
| `--only L04 R` | Run only these ids, or whole areas (`A`, `L`, `R`). |
| `--suite renderer` | Run only one suite's mutations. |
| `--whole-suite` | Run the whole suite for each mutation instead of its listed tests, to confirm a survivor is not just out of scope. |
| `--report FILE` | Write the Markdown result tables. Written only after the run (the tree must stay clean while it works), so the file may sit inside the checkout. |

Before any mutation, the probe runs each suite's selected tests unmutated.
If they already fail, it stops: every verdict would be meaningless.

## Safety

- One mutation at a time, and the tree is checked clean before each one,
  so a second probe (or an editor) in the same checkout stops the run
  instead of mixing two bugs.
- The mutated file is restored from the bytes read before the change, on
  every exit path: a pass, a failure, an exception, Ctrl+C, and
  SIGTERM / Ctrl+Break. After the run the probe checks `git status` again.
- Only a hard kill (Task Manager, `taskkill /f`) can leave a mutation
  behind. The next run then refuses the dirty tree; `git diff` shows the
  mutation and `git checkout -- <file>` removes it.

## Reading the result

Each line and each report row carries one of:

| Status | Meaning |
| --- | --- |
| `killed` | A listed test failed with the bug in place. Good. |
| `survived` | All listed tests passed with the bug in place. A test is missing or too weak. |
| `error` | The test run itself broke (exit code other than 0 or 1, e.g. an import error). Look at the summary; usually the mutation needs fixing. |
| `stale` | The find text no longer matches exactly once: the code moved. Re-anchor the entry. |

The report has a per-area summary (A = sidecar archive: Workbench,
Backups, Trash, Upload; L = sidecar Logs, Labels, Index, search and MCP;
R = renderer), a row per mutation with the audit verdict next to the
current one and the first test that caught it, and a list of survivors
with the spec whose tests are expected to kill each one. A survivor whose
spec is already done is a regression in test strength.

## The mutation list

Each `[[mutation]]` in `mutations.toml` holds the file, the exact find and
replace text, the behaviour it breaks in GLOSSARY.md terms, the tests to
run (files, globs, or `@group`s from `[groups]`), the audit verdict, and
the spec expected to kill it. The file header documents every field.

When code moves and `--check` reports an entry stale, re-anchor it on the
same behaviour; do not drop it. When a spec deletes the code a mutation
targets (e.g. the working-set modules), move the mutation to the code that
now does the job. New mutations get the next free id in their area; ids
are never reused, so results stay comparable across runs.

The probe's own tests: `sidecar\.venv\Scripts\python.exe -m pytest scripts/mutation_probe`
(CI runs them in the sidecar job).
