---
id: deploy
title: Deploy anywhere
description: Run CostKey on your laptop, a VPS, Kubernetes, Render, Railway, Fly.io, Google Cloud Run or AWS.
---

# Deploy anywhere

CostKey is one container (`ghcr.io/costkey/costkey`, for Intel and Apple Silicon) plus Postgres. It needs two secrets, `COSTKEY_JWT_SECRET` and `COSTKEY_NOTIFICATION_ENCRYPTION_KEY`; every option below generates them for you.

Once it's up, open it, sign up, and copy your project's DSN into your app. DSNs point at the address CostKey is served from. Set `PUBLIC_URL` when you add a custom domain.

## Your machine or any server

```bash
curl -fsSL https://costkey.dev/install.sh | sh
```

Docker Compose with Postgres, on port 4100. See [Self-hosting](./self-hosting) for settings, HTTPS, upgrades and backups.

## Any VPS: DigitalOcean, Hetzner, Linode, Vultr

Create an Ubuntu or Debian server and paste [`cloud-init.yaml`](https://costkey.dev/self-host/cloud-init.yaml) as its user data. When it boots, open `http://<server-ip>:4100`.

## Kubernetes

```bash
helm install costkey oci://ghcr.io/costkey/charts/costkey
kubectl port-forward svc/costkey 4100:80
```

The chart runs a small Postgres beside CostKey and generates secrets that survive upgrades. With an ingress:

```bash
helm install costkey oci://ghcr.io/costkey/charts/costkey \
  --set ingress.enabled=true --set ingress.host=costkey.your-company.com \
  --set ingress.className=nginx
```

Use a managed database with `--set postgres.enabled=false --set externalDatabaseUrl=postgresql://...`.

## Render

Deploy the [`render.yaml`](https://costkey.dev/self-host/render.yaml) Blueprint: in Render, **New → Blueprint**, point it at a repository containing that file. It creates the service from the published image and a Render Postgres, and generates the secrets. DSNs use the `onrender.com` address until you set `PUBLIC_URL`.

## Railway

1. **New project → Deploy a Docker image**: `ghcr.io/costkey/costkey:latest`.
2. **Add a service → Database → PostgreSQL**.
3. On the CostKey service, add variables:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `COSTKEY_JWT_SECRET` and `COSTKEY_NOTIFICATION_ENCRYPTION_KEY`, each the output of `openssl rand -hex 32`
   - `NODE_ENV` = `production`
4. **Settings → Networking → Generate domain** (port 4100).

DSNs use the Railway domain until you set `PUBLIC_URL`.

## Fly.io

With [`fly.toml`](https://costkey.dev/self-host/fly.toml) in an empty folder:

```bash
fly launch --copy-config --no-deploy --name your-costkey
fly postgres create --name your-costkey-db
fly postgres attach your-costkey-db
fly secrets set COSTKEY_JWT_SECRET=$(openssl rand -hex 32) COSTKEY_NOTIFICATION_ENCRYPTION_KEY=$(openssl rand -hex 32)
fly deploy
```

## Google Cloud Run

```bash
curl -fsSLO https://costkey.dev/self-host/cloud-run.sh
PROJECT=your-project REGION=us-central1 bash cloud-run.sh
```

It creates Cloud SQL for Postgres, keeps the secrets in Secret Manager, mirrors the image through Artifact Registry and deploys with one warm instance, since CostKey runs background jobs. Run it again to upgrade.

## AWS

Create a CloudFormation stack from [`aws-cloudformation.yaml`](https://costkey.dev/self-host/aws-cloudformation.yaml): in the console, **Create stack → Upload a template file**, or:

```bash
curl -fsSLO https://costkey.dev/self-host/aws-cloudformation.yaml
aws cloudformation deploy --stack-name costkey --template-file aws-cloudformation.yaml
aws cloudformation describe-stacks --stack-name costkey --query "Stacks[0].Outputs"
```

One encrypted EC2 instance runs Postgres and CostKey with Docker. Narrow `AllowedCidr` to your network. For a managed database, run the image on ECS or EKS with RDS using the [Helm chart](#kubernetes) or your own task definition.

## Vercel and other serverless platforms

CostKey isn't a fit for Vercel, Netlify or Lambda. It keeps a database connection pool and runs background work (price sync, budget alerts, daily and weekly summaries) that serverless functions stop between requests. Railway, Render and Fly.io give the same push-to-deploy feel with a long-running server.
