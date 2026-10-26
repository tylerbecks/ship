#!/usr/bin/env bash
# Print the squash commit body for a PR: its description up to a `## Screenshots` heading, without
# "Generated with" or Co-authored-by attribution lines (both kept inside code fences). Branch commits'
# trailers are left behind. Fails when the PR can't be read, so a merge never gets an empty body by
# accident. Read-only. Usage: squash-body.sh OWNER/REPO NUMBER
set -euo pipefail

repo=$1 pr=$2

description=$(gh pr view "$pr" -R "$repo" --json body -q .body)
printf '%s\n' "$description" | tr -d '\r' | awk '
  /^[[:space:]]*(```|~~~)/ { fence = !fence }
  !fence && /^## Screenshots[[:space:]]*$/ { exit }
  !fence && /^(🤖 )?Generated with \[(Claude Code|Codex)\]/ { next }
  !fence && /^[Cc]o-[Aa]uthored-[Bb]y:/ { next }
  !n && !NF { next }
  { lines[++n] = $0; if (NF) last = n }
  END { for (i = 1; i <= last; i++) print lines[i] }
'
