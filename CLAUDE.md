# CLAUDE.md

## Agent skills

### Issue tracker

GitHub Issues on FoundryBlaise/flist-workbench (public), via `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Worktrees

Parallel work goes in `scripts/agent-worktree.sh add|remove` worktrees (shared `node_modules`: never `npm install` there); usage in its header.

### Verifying

Before handing back, renaming or removing anything, or writing a helper script: `docs/agents/verifying.md` (which checks, couplings, shell gotchas).
