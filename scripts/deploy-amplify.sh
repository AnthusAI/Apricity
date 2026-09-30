#!/usr/bin/env bash
# CI runs in GitHub; the original Amplify app builds and deploys its backend and frontend.
set -euo pipefail
: "${AMPLIFY_APP_ID:?AMPLIFY_APP_ID is required}"
: "${AMPLIFY_BRANCH:?AMPLIFY_BRANCH is required}"
: "${VERIFIED_COMMIT:?VERIFIED_COMMIT is required}"

LATEST="$(gh api "repos/$GITHUB_REPOSITORY/commits/$AMPLIFY_BRANCH" --jq .sha)"
verified_revision() {
  [[ "$1" == "$VERIFIED_COMMIT" ]] && return 0
  # Semantic Release only updates CHANGELOG.md after CI in this repository.
  gh api "repos/$GITHUB_REPOSITORY/compare/$VERIFIED_COMMIT...$1" |
    jq -e --arg verified "$VERIFIED_COMMIT" '
      .status == "ahead" and .total_commits == 1 and
      .commits[0].parents[0].sha == $verified and
      (.commits[0].commit.message | startswith("chore(release): ")) and
      (.files | length == 1) and .files[0].filename == "CHANGELOG.md"
    ' >/dev/null
}
if ! verified_revision "$LATEST"; then
  echo "Skipping stale CI result: production branch has advanced."
  exit 0
fi

JOB_ID="$(aws amplify start-job --app-id "$AMPLIFY_APP_ID" \
  --branch-name "$AMPLIFY_BRANCH" --job-type RELEASE \
  --commit-id "$LATEST" --query jobSummary.jobId --output text)"
for _ in $(seq 1 480); do
  JOB="$(aws amplify get-job --app-id "$AMPLIFY_APP_ID" \
    --branch-name "$AMPLIFY_BRANCH" --job-id "$JOB_ID" --output json)"
  STATUS="$(jq -r '.job.summary.status' <<<"$JOB")"
  case "$STATUS" in
    SUCCEED)
      COMMIT="$(jq -r '.job.summary.commitId' <<<"$JOB")"
      if ! verified_revision "$COMMIT"; then
        echo "Amplify deployed $COMMIT instead of verified commit $VERIFIED_COMMIT" >&2
        exit 1
      fi
      echo "Original Amplify app deployment $JOB_ID succeeded for $COMMIT"
      exit 0
      ;;
    FAILED|CANCELLED)
      echo "Amplify deployment $JOB_ID ended with $STATUS" >&2
      exit 1
      ;;
  esac
  sleep 5
done
echo "Timed out waiting for Amplify deployment $JOB_ID" >&2
exit 1
