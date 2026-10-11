#!/usr/bin/env bash
# Deploy CostKey to Google Cloud Run, with Cloud SQL for Postgres and Secret
# Manager for secrets. Safe to run again to upgrade.
#
#   PROJECT=my-project REGION=us-central1 ./deploy.sh
#
# Needs the gcloud CLI, signed in, with billing enabled on the project.
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-costkey}"
VERSION="${COSTKEY_VERSION:-latest}"
INSTANCE="${SERVICE}-db"
[ -n "$PROJECT" ] || { echo "Set PROJECT=<your Google Cloud project>" >&2; exit 1; }
gc() { gcloud --project "$PROJECT" --quiet "$@"; }

echo "Enabling services"
gc services enable run.googleapis.com sqladmin.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com

# Cloud Run pulls from Artifact Registry; a remote repository mirrors ghcr.io.
if ! gc artifacts repositories describe ghcr --location "$REGION" >/dev/null 2>&1; then
  echo "Creating an Artifact Registry mirror of ghcr.io"
  gc artifacts repositories create ghcr --location "$REGION" --repository-format=docker \
    --mode=remote-repository --remote-docker-repo=https://ghcr.io --description="Mirror of ghcr.io for CostKey"
fi
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/ghcr/costkey/costkey:${VERSION}"

if ! gc sql instances describe "$INSTANCE" >/dev/null 2>&1; then
  echo "Creating Cloud SQL for Postgres (a few minutes)"
  gc sql instances create "$INSTANCE" --database-version=POSTGRES_16 --edition=enterprise \
    --tier=db-g1-small --region="$REGION"
fi
gc sql databases describe costkey --instance "$INSTANCE" >/dev/null 2>&1 || gc sql databases create costkey --instance "$INSTANCE"
CONNECTION="$(gc sql instances describe "$INSTANCE" --format='value(connectionName)')"

secret() {
  local name="$1" value="$2"
  if ! gc secrets describe "$name" >/dev/null 2>&1; then
    printf '%s' "$value" | gc secrets create "$name" --data-file=- --replication-policy=automatic
  fi
}
if ! gc secrets describe costkey-database-url >/dev/null 2>&1; then
  DB_PASSWORD="$(openssl rand -hex 24)"
  gc sql users create costkey --instance "$INSTANCE" --password "$DB_PASSWORD" 2>/dev/null \
    || gc sql users set-password costkey --instance "$INSTANCE" --password "$DB_PASSWORD"
  secret costkey-database-url "postgresql://costkey:${DB_PASSWORD}@/costkey?host=/cloudsql/${CONNECTION}"
fi
secret costkey-jwt-secret "$(openssl rand -hex 32)"
secret costkey-notification-key "$(openssl rand -hex 32)"

NUMBER="$(gc projects describe "$PROJECT" --format='value(projectNumber)')"
RUNNER="${NUMBER}-compute@developer.gserviceaccount.com"
for name in costkey-database-url costkey-jwt-secret costkey-notification-key; do
  gc secrets add-iam-policy-binding "$name" --member="serviceAccount:${RUNNER}" --role=roles/secretmanager.secretAccessor >/dev/null
done
gc projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${RUNNER}" --role=roles/cloudsql.client >/dev/null

echo "Deploying ${IMAGE}"
# Background work (price sync, alerts, summaries) needs a warm instance with CPU.
gc run deploy "$SERVICE" --image "$IMAGE" --region "$REGION" --port 4100 \
  --allow-unauthenticated --min-instances 1 --no-cpu-throttling --memory 1Gi \
  --add-cloudsql-instances "$CONNECTION" \
  --set-env-vars NODE_ENV=production \
  --set-secrets DATABASE_URL=costkey-database-url:latest,COSTKEY_JWT_SECRET=costkey-jwt-secret:latest,COSTKEY_NOTIFICATION_ENCRYPTION_KEY=costkey-notification-key:latest

URL="$(gc run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
gc run services update "$SERVICE" --region "$REGION" --update-env-vars "PUBLIC_URL=${URL}" >/dev/null
echo "CostKey is running at ${URL}"
