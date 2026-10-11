---
id: self-hosting
title: Self-hosting
description: Run CostKey on your own machines with Docker Compose. Postgres plus one container for the server and console.
---

# Self-hosting

CostKey is MIT licensed. A self-hosted install is two containers: Postgres, and one image that serves both the API and the console on a single port. For Kubernetes, Render, Railway, Fly.io, Cloud Run or AWS, see [Deploy anywhere](./deploy).

## Start it

You need Docker with Compose v2. Then:

```bash
curl -fsSL https://costkey.dev/install.sh | sh
```

It creates a `costkey` folder with the compose file and a `.env` with fresh secrets, pulls the image (`ghcr.io/costkey/costkey`, for Intel and Apple Silicon) and starts it.

Open `http://localhost:4100`, sign up and create your workspace. The first person to sign up owns it. Invite your team from **Settings → Team**.

### By hand

Download [`docker-compose.yml`](https://costkey.dev/self-host/docker-compose.yml) into a folder and add a `.env` beside it with the two secrets. Generate each with `openssl rand -hex 32`:

```bash
COSTKEY_JWT_SECRET=...
COSTKEY_NOTIFICATION_ENCRYPTION_KEY=...
```

Then start it:

```bash
docker compose up -d
```

## Point your SDK at it

Every project's DSN uses `PUBLIC_URL`, so a DSN from your install already points at your server:

```text
http://ck_xxx@localhost:4100/proj_xxx
```

Use it exactly like a hosted DSN:

```ts
import { CostKey } from "costkey"
CostKey.init({ dsn: process.env.COSTKEY_DSN })
```

```python
import os, costkey
costkey.init(dsn=os.environ["COSTKEY_DSN"])
```

The setup CLI can also sign in to your server:

```bash
npx costkey setup --host http://localhost:4100
```

## Settings

All settings live in `.env` next to `docker-compose.yml`.

| Setting | What it does |
| --- | --- |
| `PUBLIC_URL` | Where people and SDKs reach this server. DSNs and links in emails use it. Default `http://localhost:4100`. |
| `COSTKEY_PORT` | The port published on the host. Default `4100`. |
| `COSTKEY_JWT_SECRET` | Signs sign-in sessions. Required. |
| `COSTKEY_NOTIFICATION_ENCRYPTION_KEY` | Encrypts saved Slack and webhook URLs. Required. |
| `POSTGRES_PASSWORD` | The database password. Default `costkey`. |
| `RESEND_API_KEY`, `COSTKEY_NOTIFICATION_FROM` | Optional. Send invites, alerts and daily or weekly summaries by email through Resend. Without them, invites show a link to copy. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Optional. Sign in with GitHub. |
| `COSTKEY_COOKIE_SECURE` | Optional. Sign-in cookies are Secure when `PUBLIC_URL` is `https://`. Set `true` or `false` to override. |

## Put it behind HTTPS

Run a reverse proxy such as Caddy or nginx in front of port 4100, and set `PUBLIC_URL` to the public address:

```bash
PUBLIC_URL=https://costkey.your-company.com
```

Restart with `docker compose up -d`. New DSNs and email links use the new address. SDKs already running keep the DSN they were given, so update `COSTKEY_DSN` where you deploy them.

## Upgrade

```bash
cd costkey
docker compose pull
docker compose up -d
```

Pin a version with `COSTKEY_VERSION=0.6.1` in `.env`.

The server applies database migrations when it starts.

## Back up

Everything lives in the `costkey-postgres` volume. Back it up with:

```bash
docker compose exec postgres pg_dump -U costkey costkey > costkey-backup.sql
```

## What needs the internet

- **Prices.** The server syncs model prices every six hours from LiteLLM, models.dev and OpenRouter. The image includes a snapshot, so a fresh install has prices before its first sync.
- **Email and GitHub sign-in**, only if you set them up.

Calls from your app go straight to your providers. CostKey never sits in between.
