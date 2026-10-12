#!/usr/bin/env bash
# Serve CostKey on Cloud Run as a path on a host your regional Application
# Load Balancer already serves, e.g. https://portal.example.com/costkey, behind
# IAP. Run deploy.sh first. Safe to run again.
#
#   PROJECT=my-project REGION=asia-south1 URL_MAP=my-url-map HOST=portal.example.com \
#     IAP_MEMBERS=group:portal-users@example.com ./load-balancer-path.sh
#
# Optional:
#   PATH_PREFIX=/costkey      Path CostKey is served under (default /costkey)
#   SERVICE=costkey           Cloud Run service from deploy.sh (default costkey)
#   COPY_IAP_FROM=my-backend  Copy IAP access from an existing backend service
#                             instead of naming IAP_MEMBERS
#
# The console goes through IAP. Only the endpoints SDKs call (events, policy,
# runtime config and call graph uploads) skip IAP: they authenticate with a
# DSN key and can't sign in with Google. Every console path, /auth/me
# included, must stay behind IAP, or the console sees no identity. Run
# CostKey with COSTKEY_AUTH=iap so the console signs people in from IAP.
#
# Then point CostKey at the new address:
#   COSTKEY_INGRESS=internal-and-cloud-load-balancing \
#     COSTKEY_PUBLIC_URL=https://portal.example.com/costkey ./deploy.sh
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:?Set REGION}"
URL_MAP="${URL_MAP:?Set URL_MAP to the load balancer URL map}"
HOST="${HOST:?Set HOST to the host CostKey goes under}"
SERVICE="${SERVICE:-costkey}"
PREFIX="${PATH_PREFIX:-/costkey}"
PREFIX="/${PREFIX#/}"; PREFIX="${PREFIX%/}"
NEG="${SERVICE}-neg"
CONSOLE_BE="${SERVICE}-be"
SDK_BE="${SERVICE}-sdk-be"
gc() { gcloud --project "$PROJECT" --quiet "$@"; }

SCHEME="$(gc compute url-maps describe "$URL_MAP" --region "$REGION" --format=json \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("defaultService", "").split("/")[-1])' \
  | xargs -I{} gcloud --project "$PROJECT" compute backend-services describe {} --region "$REGION" --format='value(loadBalancingScheme)')"
SCHEME="${SCHEME:-EXTERNAL_MANAGED}"
echo "Load balancer scheme: ${SCHEME}"

gc compute network-endpoint-groups describe "$NEG" --region "$REGION" >/dev/null 2>&1 \
  || gc compute network-endpoint-groups create "$NEG" --region "$REGION" \
       --network-endpoint-type=serverless --cloud-run-service="$SERVICE"

for be in "$CONSOLE_BE" "$SDK_BE"; do
  if ! gc compute backend-services describe "$be" --region "$REGION" >/dev/null 2>&1; then
    gc compute backend-services create "$be" --region "$REGION" \
      --load-balancing-scheme="$SCHEME" --protocol=HTTP
    gc compute backend-services add-backend "$be" --region "$REGION" \
      --network-endpoint-group="$NEG" --network-endpoint-group-region="$REGION"
  fi
done

echo "Turning on IAP for the console"
gc compute backend-services update "$CONSOLE_BE" --region "$REGION" --iap=enabled
if [ -n "${COPY_IAP_FROM:-}" ]; then
  IAP_MEMBERS="$(gc iap web get-iam-policy --resource-type=backend-services --service="$COPY_IAP_FROM" \
    --region="$REGION" --format=json \
    | python3 -c 'import json,sys; print(" ".join(m for b in json.load(sys.stdin).get("bindings", []) if b["role"] == "roles/iap.httpsResourceAccessor" for m in b["members"]))')"
fi
for member in ${IAP_MEMBERS:-}; do
  gc iap web add-iam-policy-binding --resource-type=backend-services --service="$CONSOLE_BE" \
    --region="$REGION" --member="$member" --role=roles/iap.httpsResourceAccessor >/dev/null
  echo "IAP access: ${member}"
done
[ -n "${IAP_MEMBERS:-}" ] || echo "No IAP_MEMBERS given: grant roles/iap.httpsResourceAccessor on ${CONSOLE_BE} to whoever uses the console."

echo "Routing ${HOST}${PREFIX} on ${URL_MAP}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
gc compute url-maps describe "$URL_MAP" --region "$REGION" --format=json > "$WORK/current.json"
python3 - "$WORK/current.json" "$WORK/next.json" "$PROJECT" "$REGION" "$HOST" "$PREFIX" "$CONSOLE_BE" "$SDK_BE" <<'PY'
import json, sys
src, dst, project, region, host, prefix, console_be, sdk_be = sys.argv[1:]
url_map = json.load(open(src))
for key in ("id", "creationTimestamp", "kind", "selfLink"):
    url_map.pop(key, None)
base = f"https://www.googleapis.com/compute/v1/projects/{project}/regions/{region}/backendServices/"
console, sdk = base + console_be, base + sdk_be

rule = next((r for r in url_map.get("hostRules", []) if host in r["hosts"]), None)
if rule is None:
    sys.exit(f"{host} is not a host on this URL map")
matcher = next(m for m in url_map["pathMatchers"] if m["name"] == rule["pathMatcher"])

sdk_paths = [f"{prefix}/api/v1/events", f"{prefix}/api/v1/sdk/*"]
if matcher.get("pathRules"):
    # Path rules can't match /projects/<id>/config, so those go through IAP;
    # SDKs then keep their last runtime config.
    rules = [r for r in matcher["pathRules"] if r.get("service") not in (console, sdk)]
    rules.append({"paths": sdk_paths, "service": sdk})
    rules.append({"paths": [prefix, f"{prefix}/*"], "service": console})
    matcher["pathRules"] = rules
    print("Note: this host uses path rules, so SDK config and call graph requests go through IAP.")
else:
    rules = [r for r in matcher.get("routeRules", [])
             if r.get("service") not in (console, sdk)]
    taken = {r["priority"] for r in rules}
    def priority(start):
        while start in taken:
            start += 1
        taken.add(start)
        return start
    rules.append({
        "priority": priority(10),
        "matchRules": [
            {"prefixMatch": f"{prefix}/api/v1/events"},
            {"prefixMatch": f"{prefix}/api/v1/sdk/"},
            {"pathTemplateMatch": f"{prefix}/api/v1/projects/{{project=*}}/config"},
            {"pathTemplateMatch": f"{prefix}/api/v1/projects/{{project=*}}/callgraph"},
        ],
        "service": sdk,
    })
    rules.append({
        "priority": priority(11),
        "matchRules": [{"fullPathMatch": prefix}, {"prefixMatch": f"{prefix}/"}],
        "service": console,
    })
    matcher["routeRules"] = sorted(rules, key=lambda r: r["priority"])
json.dump(url_map, open(dst, "w"), indent=2)
PY
gc compute url-maps import "$URL_MAP" --region "$REGION" --source "$WORK/next.json"

echo
echo "CostKey is routed at https://${HOST}${PREFIX}"
AUDIENCE="/projects/$(gc projects describe "$PROJECT" --format='value(projectNumber)')/${REGION}/backendServices/$(gc compute backend-services describe "$CONSOLE_BE" --region "$REGION" --format='value(id)')"
echo "Now run: COSTKEY_INGRESS=internal-and-cloud-load-balancing COSTKEY_PUBLIC_URL=https://${HOST}${PREFIX} \\"
echo "  COSTKEY_AUTH=iap COSTKEY_IAP_AUDIENCE=${AUDIENCE} ./deploy.sh"
