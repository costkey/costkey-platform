---
id: deploy
title: Deploy anywhere
description: Run CostKey on your laptop, a VPS, Kubernetes, Render, Railway, Fly.io, Google Cloud Run or AWS.
---

# Deploy anywhere

CostKey is one container (`ghcr.io/costkey/costkey`, for Intel and Apple Silicon) plus Postgres. It needs two secrets, `COSTKEY_JWT_SECRET` and `COSTKEY_NOTIFICATION_ENCRYPTION_KEY`; every option below generates them for you.

Once it's up, open it, sign up, and copy your project's DSN into your app. DSNs point at the address CostKey is served from. Set `PUBLIC_URL` when you add a custom domain.

SDK 0.7 needs CostKey server 0.7.0 or later; older SDKs keep working with it. Where an example below names a version, it pins `0.7.0`.

## Your machine or any server

```bash
curl -fsSL https://costkey.dev/install.sh | sh
```

Docker Compose with Postgres, on port 4100. See [Self-hosting](./self-hosting) for settings, HTTPS, upgrades and backups.

## Any VPS: DigitalOcean Droplets, Hetzner, Linode, Vultr

Create an Ubuntu or Debian server and paste [`cloud-init.yaml`](https://costkey.dev/self-host/cloud-init.yaml) as its user data. When it boots, open `http://<server-ip>:4100`.

## Kubernetes

```bash
helm install costkey oci://ghcr.io/costkey/charts/costkey --set image.tag=0.7.0
kubectl port-forward svc/costkey 4100:80
```

The chart runs a small Postgres beside CostKey and generates secrets that survive upgrades. With an ingress:

```bash
helm install costkey oci://ghcr.io/costkey/charts/costkey --set image.tag=0.7.0 \
  --set ingress.enabled=true --set ingress.host=costkey.your-company.com \
  --set ingress.className=nginx
```

Use a managed database with `--set postgres.enabled=false --set externalDatabaseUrl=postgresql://...`.

## One click: Render and DigitalOcean

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/costkey/deploy)
[![Deploy to DigitalOcean](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/costkey/deploy/tree/main)

- **Render** creates the service from the published image and a Render Postgres, and generates the secrets. DSNs use the `onrender.com` address until you set `PUBLIC_URL`.
- **DigitalOcean** creates an App Platform app and a Postgres, and asks for the two secrets (`openssl rand -hex 32` each).

Every template here lives in [github.com/costkey/deploy](https://github.com/costkey/deploy).

## Railway

1. **New project, Deploy a Docker image**: `ghcr.io/costkey/costkey:0.7.0`.
2. **Add a service, Database, PostgreSQL**.
3. On the CostKey service, add variables:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `COSTKEY_JWT_SECRET` and `COSTKEY_NOTIFICATION_ENCRYPTION_KEY`, each the output of `openssl rand -hex 32`
   - `NODE_ENV` = `production`
4. **Settings, Networking, Generate domain** (port 4100).

DSNs use the Railway domain until you set `PUBLIC_URL`.

## Fly.io

With [`fly.toml`](https://costkey.dev/self-host/fly.toml) in an empty folder:

```bash
fly launch --copy-config --no-deploy --name your-costkey
fly postgres create --name your-costkey-db
fly postgres attach your-costkey-db
fly secrets set COSTKEY_JWT_SECRET=$(openssl rand -hex 32) COSTKEY_NOTIFICATION_ENCRYPTION_KEY=$(openssl rand -hex 32)
fly deploy --image ghcr.io/costkey/costkey:0.7.0
```

## Google Cloud Run

```bash
curl -fsSLO https://costkey.dev/self-host/cloud-run.sh
COSTKEY_VERSION=0.7.0 PROJECT=your-project REGION=us-central1 bash cloud-run.sh
```

Nothing gets a public IP.

- **Database:** Cloud SQL for Postgres on the smallest machine type (`db-f1-micro`), with a private IP in your VPC. If the VPC has no private services access, the script sets it up.
- **Secrets:** stored in Secret Manager.
- **Image:** mirrored through Artifact Registry.
- **Service:** Cloud Run, reaching the database through your VPC. It only accepts traffic from inside the VPC and anything connected to it, such as a VPN or a peered VPC. It keeps one warm instance, because CostKey runs background jobs.

Run the script again to upgrade.

| Variable | What it does |
| --- | --- |
| `NETWORK`, `SUBNET` | The VPC and subnet to use. By default it uses the project's only VPC and its first subnet in `REGION`. |
| `COSTKEY_DB_TIER` | The Cloud SQL machine type. Default `db-f1-micro`, the smallest. Set a larger one, for example `db-g1-small`, as traffic grows; a later run resizes it. |
| `COSTKEY_PUBLIC_URL` | The address SDKs and people use, such as an internal DNS name. DSNs and email links use it. |
| `COSTKEY_INGRESS` | `internal` (default), `internal-and-cloud-load-balancing`, or `all` to accept traffic from the internet. The database stays private either way. |

To reach it by an internal name:

1. Put an internal Application Load Balancer with a serverless NEG in front of the service.
2. Add a record for it in a private Cloud DNS zone.
3. Run the script again with `COSTKEY_INGRESS=internal-and-cloud-load-balancing COSTKEY_PUBLIC_URL=https://costkey.internal.your-company.com`.

## AWS

Create a CloudFormation stack from [`aws-cloudformation.yaml`](https://costkey.dev/self-host/aws-cloudformation.yaml): in the console, **Create stack, Upload a template file**, or:

```bash
curl -fsSLO https://costkey.dev/self-host/aws-cloudformation.yaml
aws cloudformation deploy --stack-name costkey --template-file aws-cloudformation.yaml
aws cloudformation describe-stacks --stack-name costkey --query "Stacks[0].Outputs"
```

One encrypted EC2 instance runs Postgres and CostKey with Docker. Narrow `AllowedCidr` to your network. For a managed database, run the image on ECS or EKS with RDS using the [Helm chart](#kubernetes) or your own task definition.

## Vercel and other serverless platforms

CostKey isn't a fit for Vercel, Netlify or Lambda. It keeps a database connection pool and runs background work (price sync, budget alerts, daily and weekly summaries) that serverless functions stop between requests. Railway, Render and Fly.io give the same push-to-deploy feel with a long-running server.
