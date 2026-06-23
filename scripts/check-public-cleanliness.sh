#!/usr/bin/env bash
#
# Public-repo cleanliness check.
#
# This repo is public, MIT-licensed, npm-published, and browsed on GitHub by
# people who have only this one repo. A public artifact must therefore stand on
# its own: it must NOT name a private repo, leak a multi-repo workspace path, or
# reference a private roadmap codename a reader has no path to.
#
# This check scans the ADDED lines of the changed files (vs a base ref) for those
# patterns and fails on any match. Scanning only added lines means a PR is judged
# on what IT introduces — pre-existing references elsewhere in a modified file
# don't trip it, and the check can be adopted without first scrubbing history.
#
# Usage:
#   check-public-cleanliness.sh <base-ref>   # scan added lines vs <base-ref> (default origin/main)
#   check-public-cleanliness.sh selftest     # assert the matcher catches a seeded violation
set -euo pipefail

# Patterns that must never be introduced into a public-repo artifact.
PATTERNS=(
  'codespar-enterprise'   # private managed-tier repo
  'codespar-web'          # private marketing/dashboard repo
  'dot-niwa'              # private coordinator repo
  'private/codespar'      # workspace-relative path into a private repo
  'public/codespar'       # workspace-relative path (coordinator layout)
  '/home/[a-z]'           # absolute workspace path
  '\.niwa/worktrees'      # niwa worktree path
  'F[0-9]+\.M[0-9]+'      # private roadmap milestone codename (e.g. F4.M5, F10.M1.3)
)

# The check, the workflow that runs it, and this script's own docs name the
# forbidden patterns by necessity — exclude them from the scan so they don't
# self-match.
EXCLUDE_PATHS=(
  'scripts/check-public-cleanliness.sh'
  '.github/workflows/cleanliness.yml'
)

# Read text on stdin; print "<lineno>:<line>" for every line matching any
# pattern. Returns 0 when at least one pattern matched, 1 when none did.
match_patterns() {
  local text hit=1 p
  text=$(cat)
  for p in "${PATTERNS[@]}"; do
    if printf '%s\n' "$text" | grep -qE -- "$p"; then
      printf '%s\n' "$text" | grep -nE -- "$p"
      hit=0
    fi
  done
  return $hit
}

run_selftest() {
  local rc=0
  # A seeded violation MUST be caught.
  if printf 'see the codespar-enterprise backend\n' | match_patterns >/dev/null; then
    echo "selftest: violation correctly caught"
  else
    echo "::error::selftest FAILED — the matcher did not catch a seeded private-repo name"
    rc=1
  fi
  # Clean text MUST pass.
  if printf 'the managed runtime exposes meta-tools\n' | match_patterns >/dev/null; then
    echo "::error::selftest FAILED — the matcher flagged clean text (false positive)"
    rc=1
  else
    echo "selftest: clean text correctly passed"
  fi
  return $rc
}

is_excluded() {
  local f="$1" e
  for e in "${EXCLUDE_PATHS[@]}"; do
    [ "$f" = "$e" ] && return 0
  done
  return 1
}

scan_changed() {
  local base="$1" found=0 f added matches scanned=0
  # NUL-delimited so paths with spaces or unusual characters are handled safely.
  while IFS= read -r -d '' f; do
    is_excluded "$f" && continue
    [ -f "$f" ] || continue
    scanned=1
    # Added lines only: the `+` side of the diff, minus the `+++` file header.
    added=$(git diff "$base"...HEAD -- "$f" | grep -E '^\+' | grep -vE '^\+\+\+' || true)
    [ -z "$added" ] && continue
    if matches=$(printf '%s\n' "$added" | match_patterns); then
      echo "::error file=$f::public-repo cleanliness: a forbidden pattern was introduced (private-repo name, workspace path, or roadmap codename)"
      printf '%s\n' "$matches"
      found=1
    fi
  done < <(git diff --name-only -z --diff-filter=ACMR "$base"...HEAD)
  [ "$scanned" -eq 0 ] && echo "no changed files to scan (vs $base)"
  return $found
}

case "${1:-}" in
  selftest) run_selftest ;;
  *)        scan_changed "${1:-origin/main}" ;;
esac
