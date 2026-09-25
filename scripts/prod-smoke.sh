#!/bin/bash
# Read-only smoke test of the deployed site, as a signed-out visitor.
# Usage: scripts/prod-smoke.sh [--url https://apricity.anth.us] [--region us-east-1]
# Needs: curl, python3, and the AWS CLI (any profile: it only calls the unauthenticated Cognito identity API
# and then uses the temporary guest credentials, never your own).
#
# Checks: TLS + 200, the cross-origin isolation headers, the wasm module, amplify_outputs.json,
# an unauthenticated GraphQL call is rejected, the hero audio is readable by a guest (ranged), and
# the rest of the bucket (records, audio) is NOT.

set -u
URL="https://apricity.anth.us"
REGION="us-east-1"
while [[ $# -gt 0 ]]; do
    case $1 in
        --url) URL="${2%/}"; shift 2 ;;
        --region) REGION="$2"; shift 2 ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
failed=0
check() { if [ "$2" = "0" ]; then echo "ok      $1"; else echo "FAILED  $1"; failed=$((failed + 1)); fi; }

# --- the page and its headers
curl -sSI "$URL/" >"$WORK/home.headers" 2>"$WORK/curl.err"; head -1 "$WORK/home.headers" | grep -q " 200"; check "GET / is 200 over TLS" $?
for h in cross-origin-opener-policy:same-origin cross-origin-embedder-policy:require-corp cross-origin-resource-policy:same-origin; do
    name="${h%%:*}"; want="${h#*:}"
    grep -i "^$name:" "$WORK/home.headers" | grep -qi "$want"; check "$name is $want" $?
done

# --- the wasm module
curl -sSI "$URL/apricity_web.wasm" >"$WORK/wasm.headers" 2>>"$WORK/curl.err"
head -1 "$WORK/wasm.headers" | grep -q " 200"; check "GET /apricity_web.wasm is 200" $?
grep -i "^content-type:" "$WORK/wasm.headers" | grep -qi "application/wasm"; check "wasm Content-Type is application/wasm" $?

# --- backend config
curl -sS -o "$WORK/outputs.json" "$URL/amplify_outputs.json" 2>>"$WORK/curl.err"
python3 - "$WORK/outputs.json" >"$WORK/outputs.env" 2>/dev/null <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print("BUCKET=%s" % d["storage"]["bucket_name"])
print("IDPOOL=%s" % d["auth"]["identity_pool_id"])
print("APIURL=%s" % d["data"]["url"])
print("REGION=%s" % d["data"]["aws_region"])
PY
[ -s "$WORK/outputs.env" ]; check "amplify_outputs.json names the bucket, identity pool and API" $?
[ -s "$WORK/outputs.env" ] || { echo "cannot continue without amplify_outputs.json"; exit 1; }
. "$WORK/outputs.env"

# --- an unauthenticated GraphQL call is rejected
code=$(curl -sS -o "$WORK/gql.out" -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    -d '{"query":"query { listSamples { items { id } } }"}' "$APIURL" 2>>"$WORK/curl.err")
[ "$code" = "401" ] || [ "$code" = "403" ]; check "GraphQL without credentials is rejected (got $code)" $?

# --- guest credentials from the identity pool (no account, no password: the pool's unauthenticated role)
IDENTITY=$(aws cognito-identity get-id --identity-pool-id "$IDPOOL" --region "$REGION" --no-sign-request --query IdentityId --output text 2>"$WORK/aws.err")
[ -n "$IDENTITY" ] && [ "$IDENTITY" != "None" ]; check "the identity pool issues a guest identity" $?
CREDS=$(aws cognito-identity get-credentials-for-identity --identity-id "$IDENTITY" --region "$REGION" --no-sign-request \
    --query 'Credentials.[AccessKeyId,SecretKey,SessionToken]' --output text 2>>"$WORK/aws.err")
AK=$(echo "$CREDS" | cut -f1); SK=$(echo "$CREDS" | cut -f2); ST=$(echo "$CREDS" | cut -f3)
[ -n "$AK" ] && [ "$AK" != "None" ]; check "guest credentials issued" $?

s3get() { # key -> exit status of a ranged GET as the guest
    env -u AWS_PROFILE AWS_ACCESS_KEY_ID="$AK" AWS_SECRET_ACCESS_KEY="$SK" AWS_SESSION_TOKEN="$ST" \
        aws s3api get-object --bucket "$BUCKET" --key "$1" --range bytes=0-0 --region "$REGION" "$WORK/obj" >"$WORK/s3.out" 2>"$WORK/s3.err"
}

# Every breakdown's audio is public, straight from the committed bundles.
BREAKDOWN_KEYS="$(python3 -c '
import json, sys
for f in sys.argv[1:]:
    a = json.load(open(f))["audio"]
    print("\n".join("files/" + k for k in dict.fromkeys(a["sources"] + [t["key"] for t in a["tracks"]])))
' "$(dirname "$0")"/../web/src/breakdowns/*.json)"
for k in $BREAKDOWN_KEYS; do
    s3get "$k"; check "guest can read $k" $?
done
# Nothing else is public: a record and an audio file must be denied.
for k in Recording/rec_denied_probe.json files/audio/denied_probe.wav; do
    s3get "$k"; rc=$?
    [ $rc -ne 0 ] && grep -q "AccessDenied\|Forbidden" "$WORK/s3.err"; check "guest is denied $k" $?
done

if [ "$failed" = "0" ]; then echo; echo "prod smoke: all checks passed"; else echo; echo "prod smoke: $failed check(s) FAILED"; exit 1; fi
