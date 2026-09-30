#!/usr/bin/env bash
# Publish an already-tested static artifact to a manual-deployment Amplify app.
# This script deliberately never builds or tests the site.
set -euo pipefail

ARTIFACT_DIR="${1:?usage: deploy-amplify.sh <artifact-directory>}"
: "${AMPLIFY_APP_ID:?AMPLIFY_APP_ID is required}"
: "${AMPLIFY_BRANCH:?AMPLIFY_BRANCH is required}"

if [[ ! -d "$ARTIFACT_DIR" ]]; then
  echo "artifact directory does not exist: $ARTIFACT_DIR" >&2
  exit 2
fi

ARCHIVE="$(mktemp "${TMPDIR:-/tmp}/apricity-site.XXXXXX")"
trap 'rm -f "$ARCHIVE"' EXIT
rm -f "$ARCHIVE"
(cd "$ARTIFACT_DIR" && zip -q -r "$ARCHIVE" .)

DEPLOYMENT="$(aws amplify create-deployment \
  --app-id "$AMPLIFY_APP_ID" \
  --branch-name "$AMPLIFY_BRANCH" \
  --output json)"
JOB_ID="$(jq -r '.jobId // empty' <<<"$DEPLOYMENT")"
UPLOAD_URL="$(jq -r '.zipUploadUrl // empty' <<<"$DEPLOYMENT")"

if [[ -z "$JOB_ID" || -z "$UPLOAD_URL" ]]; then
  echo "Amplify did not return a manual-deployment upload URL and job ID" >&2
  exit 1
fi

curl --fail --silent --show-error --request PUT --upload-file "$ARCHIVE" "$UPLOAD_URL"
aws amplify start-deployment \
  --app-id "$AMPLIFY_APP_ID" \
  --branch-name "$AMPLIFY_BRANCH" \
  --job-id "$JOB_ID" >/dev/null

for _ in $(seq 1 120); do
  STATUS="$(aws amplify get-job \
    --app-id "$AMPLIFY_APP_ID" \
    --branch-name "$AMPLIFY_BRANCH" \
    --job-id "$JOB_ID" \
    --query 'job.summary.status' \
    --output text)"
  case "$STATUS" in
    SUCCEED)
      echo "Amplify deployment $JOB_ID succeeded"
      exit 0
      ;;
    FAILED|CANCELLED)
      echo "Amplify deployment $JOB_ID ended with status: $STATUS" >&2
      exit 1
      ;;
  esac
  sleep 5
done

echo "Timed out waiting for Amplify deployment $JOB_ID" >&2
exit 1
