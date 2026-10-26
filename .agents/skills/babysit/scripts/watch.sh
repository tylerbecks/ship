#!/usr/bin/env bash
# Print a PR's state, then block until it changes (or 10 minutes pass) and print it again.
# Read-only: it only calls `gh` for fixed queries. It detects change; it is not a full record of the
# discussion (read that with `gh pr view NUMBER --comments`). Usage: watch.sh OWNER/REPO NUMBER [INTERVAL_SEC]
set -euo pipefail

repo=$1 pr=$2 interval=${3:-30}
owner=${repo%/*} name=${repo#*/}

snapshot() {
  gh api graphql -F owner="$owner" -F name="$name" -F pr="$pr" -f query='
    query($owner: String!, $name: String!, $pr: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $pr) {
          state isDraft mergeable headRefOid
          commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
          reviewThreads(first: 100) {
            nodes { id isResolved isOutdated path line
              first: comments(first: 1) { nodes { author { login } body } }
              latest: comments(last: 1) { totalCount nodes { author { login } updatedAt } } }
          }
          reviews(last: 20) { nodes { id author { login } state submittedAt commit { oid } } }
          comments(last: 20) { nodes { id author { login } updatedAt } }
        }
      }
    }' --jq '.data.repository.pullRequest | {
      state, isDraft, mergeable, head: .headRefOid,
      checks: (.commits.nodes[0].commit.statusCheckRollup.state // "NONE"),
      unresolvedThreads: [.reviewThreads.nodes[] | select(.isResolved | not)
        | {id, isOutdated, path, line, author: .first.nodes[0].author.login,
           body: .first.nodes[0].body, replies: (.latest.totalCount - 1),
           latest: {author: .latest.nodes[0].author.login, updatedAt: .latest.nodes[0].updatedAt}}],
      reviews: [.reviews.nodes[] | {id, author: .author.login, state, submittedAt, commit: .commit.oid}],
      comments: [.comments.nodes[] | {id, author: .author.login, updatedAt}]
    }'
}

first=$(snapshot)
echo "$first"
case $(jq -r .state <<<"$first") in MERGED|CLOSED) exit 0 ;; esac

deadline=$((SECONDS + 600))
while ((SECONDS < deadline)); do
  sleep "$interval"
  # A failed poll is not a PR change; keep waiting.
  current=$(snapshot 2>/dev/null) || continue
  if [[ $current != "$first" ]]; then
    echo "$current"
    exit 0
  fi
done
echo '{"type":"QUIET"}'
