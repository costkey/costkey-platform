#!/usr/bin/env bash
# Deploy CostKey to Google Cloud Run, privately: Cloud SQL for Postgres on a
# private IP only, secrets in Secret Manager, and a Cloud Run service that only
# accepts traffic from your VPC. Nothing gets a public IP. Safe to run again to
# upgrade.
#
#   PROJECT=my-project REGION=us-central1 ./deploy.sh
#
# Optional:
#   NETWORK=my-vpc           VPC to use (default: the project's only VPC, or "default")
#   SUBNET=my-subnet         Subnet in REGION for Cloud Run egress (default: the first one on NETWORK)
#   COSTKEY_VERSION=0.7.0    Image tag (default: latest)
#   COSTKEY_DB_TIER=db-g1-small
#                            Cloud SQL machine type (default: db-f1-micro, the smallest).
#                            Changing it on a later run resizes the database (a short restart).
#   COSTKEY_PUBLIC_URL=https://costkey.internal.example.com
#                            The address SDKs and people use, e.g. an internal DNS name.
#                            DSNs and email links use it. Default: the Cloud Run URL.
#   COSTKEY_INGRESS=internal internal (default), internal-and-cloud-load-balancing, or all.
#                            "all" makes the service reachable from the internet;
#                            the database stays private either way.
#
# Needs the gcloud CLI, signed in, with billing enabled on the project.
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-costkey}"
VERSION="${COSTKEY_VERSION:-latest}"
INGRESS="${COSTKEY_INGRESS:-internal}"
DB_TIER="${COSTKEY_DB_TIER:-db-f1-micro}"
INSTANCE="${SERVICE}-db"
[ -n "$PROJECT" ] || { echo "Set PROJECT=<your Google Cloud project>" >&2; exit 1; }
case "$INGRESS" in
  internal|internal-and-cloud-load-balancing|all) ;;
  *) echo "COSTKEY_INGRESS must be internal, internal-and-cloud-load-balancing or all" >&2; exit 1 ;;
esac
gc() { gcloud --project "$PROJECT" --quiet "$@"; }
# Cloud SQL creates and resizes can outlast gcloud's 10 minute wait, so start
# them async and wait for the operation as long as it takes.
sql_wait() { gc sql operations wait "$1" --timeout=unlimited >/dev/null; }

echo "Enabling services"
gc services enable run.googleapis.com sqladmin.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com compute.googleapis.com servicenetworking.googleapis.com

# The VPC everything lives on.
if [ -z "${NETWORK:-}" ]; then
  networks="$(gc compute networks list --format='value(name)')"
  if [ "$(printf '%s\n' "$networks" | grep -c .)" = "1" ]; then NETWORK="$networks"; else NETWORK="default"; fi
fi
gc compute networks describe "$NETWORK" >/dev/null 2>&1 \
  || { echo "No VPC named ${NETWORK}. Set NETWORK=<your VPC>." >&2; exit 1; }
if [ -z "${SUBNET:-}" ]; then
  SUBNET="$(gc compute networks subnets list --network="$NETWORK" --regions="$REGION" \
    --filter='purpose=PRIVATE OR -purpose:*' --format='value(name)' | head -n1)"
fi
[ -n "$SUBNET" ] || { echo "No subnet on ${NETWORK} in ${REGION}. Set SUBNET=<subnet>." >&2; exit 1; }
echo "Using VPC ${NETWORK}, subnet ${SUBNET}"

# Cloud SQL private IP needs private services access on the VPC. Reuse it if
# it's already set up; otherwise reserve a range and connect.
if ! gc services vpc-peerings list --network="$NETWORK" --format='value(peering)' | grep -q servicenetworking; then
  echo "Setting up private services access on ${NETWORK}"
  gc compute addresses describe costkey-psa --global >/dev/null 2>&1 \
    || gc compute addresses create costkey-psa --global --purpose=VPC_PEERING --prefix-length=20 --network="$NETWORK"
  gc services vpc-peerings connect --service=servicenetworking.googleapis.com --ranges=costkey-psa --network="$NETWORK"
fi

# Cloud Run pulls from Artifact Registry; a remote repository mirrors ghcr.io.
if ! gc artifacts repositories describe ghcr --location "$REGION" >/dev/null 2>&1; then
  echo "Creating an Artifact Registry mirror of ghcr.io"
  gc artifacts repositories create ghcr --location "$REGION" --repository-format=docker \
    --mode=remote-repository --remote-docker-repo=https://ghcr.io --description="Mirror of ghcr.io for CostKey"
fi
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/ghcr/costkey/costkey:${VERSION}"

for op in $(gc sql operations list --instance="$INSTANCE" --filter='status!=DONE' --format='value(name)' 2>/dev/null); do
  echo "Waiting for an earlier Cloud SQL operation to finish"
  sql_wait "$op"
done
if ! gc sql instances describe "$INSTANCE" >/dev/null 2>&1; then
  echo "Creating Cloud SQL for Postgres on a private IP (a few minutes)"
  op="$(gc sql instances create "$INSTANCE" --database-version=POSTGRES_16 --edition=enterprise \
    --tier="$DB_TIER" --region="$REGION" \
    --network="projects/${PROJECT}/global/networks/${NETWORK}" --no-assign-ip \
    --async --format='value(name)')"
  sql_wait "$op"
fi
if [ "$(gc sql instances describe "$INSTANCE" --format='value(settings.tier)')" != "$DB_TIER" ]; then
  echo "Resizing ${INSTANCE} to ${DB_TIER}"
  op="$(gc sql instances patch "$INSTANCE" --tier="$DB_TIER" --async --format='value(name)')"
  sql_wait "$op"
fi
gc sql databases describe costkey --instance "$INSTANCE" >/dev/null 2>&1 || gc sql databases create costkey --instance "$INSTANCE"
DB_HOST="$(gc sql instances describe "$INSTANCE" --format=json \
  | python3 -c 'import json,sys; print(next((a["ipAddress"] for a in json.load(sys.stdin).get("ipAddresses", []) if a.get("type") == "PRIVATE"), ""))')"
[ -n "$DB_HOST" ] || { echo "${INSTANCE} has no private IP. Delete it or add one: gcloud sql instances patch ${INSTANCE} --network=${NETWORK}" >&2; exit 1; }

secret() {
  local name="$1" value="$2"
  if ! gc secrets describe "$name" >/dev/null 2>&1; then
    # Stored in REGION, not replicated globally, so org location policies allow it.
    printf '%s' "$value" | gc secrets create "$name" --data-file=- \
      --replication-policy=user-managed --locations="$REGION"
  else
    printf '%s' "$value" | gc secrets versions add "$name" --data-file=- >/dev/null
  fi
}
# A database URL from an older run that used the Cloud SQL socket is replaced.
CURRENT_DB_URL="$(gc secrets versions access latest --secret=costkey-database-url 2>/dev/null || true)"
case "$CURRENT_DB_URL" in
  *"@${DB_HOST}:5432/"*) ;;
  *)
    DB_PASSWORD="$(openssl rand -hex 24)"
    gc sql users create costkey --instance "$INSTANCE" --password "$DB_PASSWORD" 2>/dev/null \
      || gc sql users set-password costkey --instance "$INSTANCE" --password "$DB_PASSWORD"
    secret costkey-database-url "postgresql://costkey:${DB_PASSWORD}@${DB_HOST}:5432/costkey"
    ;;
esac
gc secrets describe costkey-jwt-secret >/dev/null 2>&1 || secret costkey-jwt-secret "$(openssl rand -hex 32)"
gc secrets describe costkey-notification-key >/dev/null 2>&1 || secret costkey-notification-key "$(openssl rand -hex 32)"

NUMBER="$(gc projects describe "$PROJECT" --format='value(projectNumber)')"
RUNNER="${NUMBER}-compute@developer.gserviceaccount.com"
for name in costkey-database-url costkey-jwt-secret costkey-notification-key; do
  gc secrets add-iam-policy-binding "$name" --member="serviceAccount:${RUNNER}" --role=roles/secretmanager.secretAccessor >/dev/null
done

echo "Deploying ${IMAGE} (ingress: ${INGRESS})"
# Background work (price sync, alerts, summaries, quality checks) needs a warm
# instance with CPU. SDKs authenticate with their DSN, so Cloud Run's IAM
# invoker check is off; ingress decides who can reach the service.
gc run deploy "$SERVICE" --image "$IMAGE" --region "$REGION" --port 4100 \
  --ingress "$INGRESS" --no-invoker-iam-check \
  --network "$NETWORK" --subnet "$SUBNET" --vpc-egress private-ranges-only \
  --min-instances 1 --no-cpu-throttling --memory 1Gi \
  --set-env-vars NODE_ENV=production \
  --set-secrets DATABASE_URL=costkey-database-url:latest,COSTKEY_JWT_SECRET=costkey-jwt-secret:latest,COSTKEY_NOTIFICATION_ENCRYPTION_KEY=costkey-notification-key:latest

URL="$(gc run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
PUBLIC_URL="${COSTKEY_PUBLIC_URL:-$URL}"
gc run services update "$SERVICE" --region "$REGION" --update-env-vars "PUBLIC_URL=${PUBLIC_URL}" >/dev/null

echo
echo "CostKey is running at ${PUBLIC_URL}"
if [ "$INGRESS" = "internal" ]; then
  echo "It only accepts traffic from inside ${NETWORK} (and VPCs and VPNs connected to it)."
  echo "To give it an internal name, put an internal Application Load Balancer with a"
  echo "serverless NEG in front of it, add a private Cloud DNS record, then run again with"
  echo "COSTKEY_INGRESS=internal-and-cloud-load-balancing COSTKEY_PUBLIC_URL=https://<that name>."
fi
