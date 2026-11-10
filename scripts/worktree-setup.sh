#!/usr/bin/env bash
# Create an agent worktree the one way, or audit the worktree directory.
#
#   scripts/worktree-setup.sh <name> <branch>
#       git worktree add <main>/.claude/worktrees/<name> -b <branch> origin/main
#       (fetched first), local user.email / user.name copied from the main
#       clone, and node_modules SYMLINKED to the main clone's.
#
#   scripts/worktree-setup.sh --prune
#       `git worktree prune`, then LISTS — never deletes — directories under
#       .claude/worktrees that are not registered worktrees, and registered
#       worktrees that carry a real (installed) node_modules.
#
# Never `npm install` in a worktree. Six of thirteen worktrees once held a full
# install each (gigabytes, and every install a CPU-bound minute on a machine
# that was already swapping). The symlinked node_modules IS the main clone's
# directory: an install there rewrites main's dependencies under every other
# agent. Note what the link means: `@camstack/*` resolves to the MAIN clone's
# packages, so a change to a framework package is proven on assembled main by
# the coordinator's verify:push, not by a run in the worktree.
set -euo pipefail

usage() {
  echo "usage: $0 <name> <branch> | --prune" >&2
  exit 2
}

# The main clone: the parent of the common git dir, whichever worktree we run from.
COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir)
MAIN=$(dirname "$COMMON_DIR")
WT_ROOT="$MAIN/.claude/worktrees"

prune() {
  git -C "$MAIN" worktree prune
  local registered dir found=0
  registered=$(git -C "$MAIN" worktree list --porcelain | sed -n 's/^worktree //p')
  if [[ -d "$WT_ROOT" ]]; then
    for dir in "$WT_ROOT"/*/; do
      [[ -d "$dir" ]] || continue
      dir="${dir%/}"
      if ! grep -qxF "$dir" <<<"$registered"; then
        if [[ -f "$dir/.git" ]] && ! grep -qF "$COMMON_DIR" "$dir/.git"; then
          echo "foreign (a worktree of another repository, e.g. the viewer): $dir"
        else
          echo "stray (not a registered worktree, not deleted): $dir"
        fi
        found=1
      fi
    done
  fi
  while IFS= read -r dir; do
    [[ -n "$dir" && "$dir" != "$MAIN" ]] || continue
    if [[ -d "$dir/node_modules" && ! -L "$dir/node_modules" ]]; then
      echo "installed node_modules (not a link to main, not deleted): $dir/node_modules"
      found=1
    fi
  done <<<"$registered"
  if [[ $found -eq 0 ]]; then echo "worktree-setup: nothing stray under $WT_ROOT"; fi
}

create() {
  local name="$1" branch="$2" dest email username
  if ! [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "worktree-setup: name '$name' must be one path segment ([A-Za-z0-9._-])" >&2
    exit 2
  fi
  dest="$WT_ROOT/$name"
  if [[ -e "$dest" ]]; then
    echo "worktree-setup: $dest already exists — pick another name, or run --prune to see what it is" >&2
    exit 1
  fi
  if git -C "$MAIN" show-ref --verify --quiet "refs/heads/$branch"; then
    echo "worktree-setup: branch '$branch' already exists — pick a new branch name" >&2
    exit 1
  fi
  if [[ ! -d "$MAIN/node_modules" ]]; then
    echo "worktree-setup: $MAIN/node_modules is missing — the main clone must be installed first" >&2
    exit 1
  fi

  git -C "$MAIN" fetch origin main --quiet
  mkdir -p "$WT_ROOT"
  git -C "$MAIN" worktree add --quiet -b "$branch" "$dest" origin/main

  # The author identity of the main clone (this repository is committed with a
  # personal address, never a work one).
  email=$(git -C "$MAIN" config user.email || true)
  username=$(git -C "$MAIN" config user.name || true)
  if [[ -n "$email" ]]; then git -C "$dest" config --local user.email "$email"; fi
  if [[ -n "$username" ]]; then git -C "$dest" config --local user.name "$username"; fi

  ln -s "$MAIN/node_modules" "$dest/node_modules"

  echo "worktree-setup: $dest on $branch (from origin/main)"
  echo "  author:       ${username:-<unset>} <${email:-unset}>"
  echo "  node_modules: -> $MAIN/node_modules (never npm install here)"
  echo "  tests:        npm run test:related -- <files>   typecheck: npm run typecheck:pkg -- <dir>"
}

case "${1:-}" in
  --prune)
    [[ $# -eq 1 ]] || usage
    prune
    ;;
  --install | --npm-install)
    echo "worktree-setup: refused — never npm install in a worktree; node_modules is the main clone's" >&2
    exit 2
    ;;
  -* | '')
    usage
    ;;
  *)
    [[ $# -eq 2 ]] || usage
    create "$1" "$2"
    ;;
esac
