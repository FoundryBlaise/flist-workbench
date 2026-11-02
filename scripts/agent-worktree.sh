#!/usr/bin/env bash
# Throwaway git worktrees for agents (and people) working in parallel.
#
#   scripts/agent-worktree.sh add <name> <branch> [base]
#   scripts/agent-worktree.sh remove <name> [--delete-branch[=<into>]]
#   scripts/agent-worktree.sh run <name> -- <command...>
#
# add: creates .claude/worktrees/<name> in the main checkout (git-ignored)
#   on <branch>; a new branch starts at [base] (default: HEAD of the
#   checkout you run this from), an existing one is checked out as is.
#   node_modules is a link to the main checkout's (a junction on
#   Windows, a symlink elsewhere), so NEVER run npm install / npm ci /
#   electron-rebuild in the worktree: it would rewrite the shared folder.
#   The sidecar venv is the worktree's own (`uv sync --project sidecar`),
#   and resources/browser-extension is copied when the main checkout has
#   it (the e2e extension spec needs it).
#
# remove: refuses while the worktree has uncommitted changes to tracked
#   files. Unlinks node_modules first, so deleting the worktree can never
#   walk into the main checkout's node_modules, then runs
#   `git worktree remove --force` (which also drops untracked files and
#   the venv). --delete-branch then deletes the branch, but only if it is
#   merged: into the main checkout's HEAD (`git branch -d`), or with
#   --delete-branch=<into> into that branch, e.g. an integration branch
#   the ticket branches were merged into instead of main.
#
# run: runs <command> inside the worktree while holding its lock, and
#   refuses at once (exit 75) if another `run` holds it. A worktree that
#   several agents take turns on (an integration branch) is only touched
#   through `run`, so a merge can never change files under another
#   agent's test run. The lock is .claude/worktrees/<name>.lock; one left by a killed
#   run names its holder, and deleting it frees the worktree.
set -euo pipefail

die() { echo "agent-worktree: $*" >&2; exit 1; }

is_windows() {
  case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) return 0 ;; *) return 1 ;; esac
}

# The main checkout, from wherever this runs (main checkout or any worktree).
common_dir=$(git rev-parse --path-format=absolute --git-common-dir) || die "not inside a git checkout"
MAIN=$(dirname "$common_dir")
WORKTREES="$MAIN/.claude/worktrees"

check_name() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "name must be letters, digits, . _ - (got '$1')"
}

# True when $1 is a symlink or (on Windows) a junction.
is_link() {
  local path=$1
  [ -L "$path" ] && return 0
  # Git Bash reports a junction as a link; ask Windows too, in case not.
  if is_windows && [ -e "$path" ]; then
    fsutil reparsepoint query "$(cygpath -w "$path")" >/dev/null 2>&1 && return 0
  fi
  return 1
}

# Removes the link itself, never what it points to.
unlink_dir() {
  local path=$1
  if is_windows; then
    # rmdir without /s removes a junction, not its target's contents.
    cmd //c rmdir "$(cygpath -w "$path")" >/dev/null
  else
    rm "$path"
  fi
}

cmd_add() {
  [ $# -ge 2 ] && [ $# -le 3 ] || die "usage: add <name> <branch> [base]"
  local name=$1 branch=$2 base=${3:-HEAD}
  check_name "$name"
  local wt="$WORKTREES/$name"
  [ -e "$wt" ] && die "$wt already exists"

  mkdir -p "$WORKTREES"
  if git -C "$MAIN" show-ref --verify --quiet "refs/heads/$branch"; then
    [ $# -eq 3 ] && die "branch $branch already exists; leave out [base] to check it out"
    git -C "$MAIN" worktree add "$wt" "$branch"
  else
    git -C "$MAIN" worktree add -b "$branch" "$wt" "$(git rev-parse --verify "$base^{commit}")"
  fi

  if [ -d "$MAIN/node_modules" ]; then
    if is_windows; then
      cmd //c mklink //J "$(cygpath -w "$wt/node_modules")" "$(cygpath -w "$MAIN/node_modules")" >/dev/null
    else
      ln -s "$MAIN/node_modules" "$wt/node_modules"
    fi
  else
    echo "agent-worktree: $MAIN has no node_modules; run npm ci there first" >&2
  fi

  if [ -d "$MAIN/resources/browser-extension" ]; then
    mkdir -p "$wt/resources"
    cp -r "$MAIN/resources/browser-extension" "$wt/resources/"
  fi

  if command -v uv >/dev/null 2>&1; then
    (cd "$wt" && uv sync --project sidecar -q) || echo "agent-worktree: uv sync failed; run it in $wt/sidecar" >&2
  else
    echo "agent-worktree: uv not on PATH; the sidecar venv was not created" >&2
  fi

  echo "$wt ready on $branch @ $(git -C "$wt" rev-parse --short HEAD)"
}

cmd_remove() {
  [ $# -ge 1 ] && [ $# -le 2 ] || die "usage: remove <name> [--delete-branch[=<into>]]"
  local name=$1 delete_branch="" into=""
  case "${2:-}" in
    "") ;;
    --delete-branch) delete_branch=1 ;;
    --delete-branch=?*) delete_branch=1 into=${2#--delete-branch=} ;;
    *) die "unknown option $2" ;;
  esac
  check_name "$name"
  local wt="$WORKTREES/$name"
  [ -d "$wt" ] || die "no worktree at $wt"
  [ ! -e "$WORKTREES/$name.lock" ] || die "$name is busy: $(holder "$name")"
  if [ -n "$into" ]; then
    git -C "$MAIN" rev-parse --verify --quiet "$into^{commit}" >/dev/null || die "no branch or commit $into"
  fi

  local dirty
  dirty=$(git -C "$wt" status --porcelain --untracked-files=no)
  [ -z "$dirty" ] || die "$wt has uncommitted changes to tracked files; commit or discard them first:
$dirty"
  local branch
  branch=$(git -C "$wt" symbolic-ref --quiet --short HEAD || true)

  local nm="$wt/node_modules"
  if is_link "$nm"; then
    unlink_dir "$nm"
    ! is_link "$nm" || die "could not unlink $nm; not removing the worktree"
  fi

  git -C "$MAIN" worktree remove --force "$wt"
  echo "removed $wt"

  if [ -n "$delete_branch" ] && [ -n "$branch" ]; then
    if [ -z "$into" ]; then
      git -C "$MAIN" branch -d "$branch" || echo "agent-worktree: kept $branch (not merged)" >&2
    elif git -C "$MAIN" merge-base --is-ancestor "$branch" "$into"; then
      # -D because -d would check against the main checkout's HEAD; the
      # ancestor check above is the merge check.
      git -C "$MAIN" branch -D "$branch"
    else
      echo "agent-worktree: kept $branch (not merged into $into)" >&2
    fi
  fi
}

# Who holds <name>'s lock, as its `run` wrote it.
holder() {
  cat "$WORKTREES/$1.lock/holder" 2>/dev/null || echo "holder unknown; delete $WORKTREES/$1.lock if no run is going"
}

cmd_run() {
  [ $# -ge 3 ] && [ "$2" = "--" ] || die "usage: run <name> -- <command...>"
  local name=$1
  shift 2
  check_name "$name"
  local wt="$WORKTREES/$name"
  [ -d "$wt" ] || die "no worktree at $wt"

  # mkdir is atomic: of two runs starting together, exactly one gets it.
  LOCK="$WORKTREES/$name.lock"
  if ! mkdir "$LOCK" 2>/dev/null; then
    echo "agent-worktree: $name is busy: $(holder "$name")" >&2
    exit 75
  fi
  trap 'rm -rf "$LOCK"' EXIT
  trap 'exit 130' INT TERM
  printf 'pid %s since %s: %s\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >"$LOCK/holder"

  (cd "$wt" && "$@")
}

case "${1:-}" in
  add) shift; cmd_add "$@" ;;
  remove) shift; cmd_remove "$@" ;;
  run) shift; cmd_run "$@" ;;
  *) die "usage: $0 add <name> <branch> [base] | remove <name> [--delete-branch[=<into>]] | run <name> -- <command...>" ;;
esac
