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

SDK 0.7 needs CostKey server 0.7.0 or later. Older SDKs keep working with the new server, so upgrade the server first.

Open `http://localhost:4100`, sign up and create your workspace. The first person to sign up owns it. Invite your team from **Settings, Team**.

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
| `COSTKEY_NOTIFICATION_ENCRYPTION_KEY` | Encrypts saved Slack and webhook URLs and quality check judge API keys. Required. |
| `POSTGRES_PASSWORD` | The database password. Default `costkey`. |
| `RESEND_API_KEY`, `COSTKEY_NOTIFICATION_FROM` | Optional. Send invites, alerts and daily or weekly summaries by email through Resend. Without them, invites show a link to copy. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Optional. Sign in with GitHub. Password mode only. |
| `COSTKEY_AUTH` | Optional. How people sign in: `password`, `iap` or `oidc`. Default `password`. See [Sign-in](#sign-in). |
| `COSTKEY_COOKIE_SECURE` | Optional. Sign-in cookies are Secure when `PUBLIC_URL` is `https://`. Set `true` or `false` to override. |
| `COSTKEY_VERSION` | Optional. The image tag to run, such as `0.7.0`. Default `latest`. |
| `COSTKEY_QUALITY_SETTLE_SECONDS` | Optional. Seconds a run must be idle before [quality checks](./quality-checks) score it. Default `120`. |
| `COSTKEY_QUALITY_JUDGE_RPM` | Optional. Most LLM judge calls per minute for each project. Default `30`. |
| `COSTKEY_QUALITY_WORKER_INTERVAL_SECONDS` | Optional. Seconds between runs of the quality check worker. Default `15`. |

## Sign-in

`COSTKEY_AUTH` picks how people sign in to the console. SDKs are not affected. They always use the project DSN.

| Mode | Who signs people in |
| --- | --- |
| `password` | CostKey. Email and password, plus GitHub when `GITHUB_CLIENT_ID` is set. This is the default. |
| `iap` | Google Cloud Identity-Aware Proxy in front of CostKey. People pass IAP with their Google account and land in the console signed in. |
| `oidc` | Your OpenID Connect provider, such as Google Workspace, Okta or Microsoft Entra ID. The sign-in page shows one "Continue with" button. |

In `iap` and `oidc` modes the server turns off password sign-in, signup and GitHub sign-in. The routes refuse requests. They are not just hidden.

### Who gets in, and with what role

People are matched by email. If you switch an existing install from passwords to SSO, everyone keeps their account, role and data.

- The first person to sign in to an empty install creates the workspace and becomes its owner.
- Everyone after that joins the workspace with `COSTKEY_SSO_DEFAULT_ROLE` and is added to its projects.
- To give someone a different role or only some projects, invite them first in Settings, Team. The invite applies the first time they sign in. Nothing needs to be clicked.
- Owners and admins can still change roles and remove members. A removed member cannot sign back in until they are invited again.

| Setting | What it does |
| --- | --- |
| `COSTKEY_SSO_DEFAULT_ROLE` | Optional. The role for people who sign in without an invite: `admin`, `developer` or `viewer`. Default `developer`. An unknown value is logged and `viewer` is used. |

### Identity-Aware Proxy

Use this when CostKey runs on Cloud Run behind a Google Cloud Application Load Balancer with IAP turned on.

| Setting | What it does |
| --- | --- |
| `COSTKEY_AUTH` | `iap` |
| `COSTKEY_IAP_AUDIENCE` | Required. The IAP audience of the load balancer's backend service. List several with commas. |

The audience is `/projects/<project number>/<region>/backendServices/<id>` for a regional load balancer (no `regions/` segment, for example `/projects/123/asia-south1/backendServices/456`), or `/projects/<project number>/global/backendServices/<id>` for a global one. Use the project number, not the project ID. Find the two numbers with:

```bash
gcloud projects describe <project-id> --format='value(projectNumber)'
gcloud compute backend-services describe <backend-service> --region <region> --format='value(id)'
```

For a global backend service, use `--global` in place of `--region <region>`.

CostKey checks the signed `x-goog-iap-jwt-assertion` header on every console request. It verifies the signature with Google's public keys, and checks the issuer, the audience and the expiry. It never trusts the unsigned `x-goog-authenticated-user-email` header. A request without a valid header gets no console session, even with an old session cookie.

SDKs cannot pass IAP, so route these paths to CostKey around IAP. For example, use a second backend service without IAP for them on the same load balancer:

- `/api/v1/events`
- `/api/v1/sdk/*`
- `/api/v1/projects/*/config`
- `/api/v1/projects/*/callgraph`

They still need the project DSN. Set the Cloud Run service's ingress to internal and Cloud Load Balancing, so nobody can reach it around the load balancer.

Signing out of CostKey also sends the browser to `/_gcp_iap/clear_login_cookie` under `PUBLIC_URL`, so IAP asks for the Google account again.

`npx costkey setup --host <PUBLIC_URL>` signs in through IAP in the browser and hands the CLI its token. The CLI then calls `/auth/me` and `/api/v1/projects` with that token, which IAP blocks. Route those two exact paths around IAP too if you want the CLI to finish on its own. Without IAP they accept only a CLI token, never a console session. Otherwise copy the DSN from the console.

### OpenID Connect

| Setting | What it does |
| --- | --- |
| `COSTKEY_AUTH` | `oidc` |
| `COSTKEY_OIDC_ISSUER` | Required. The issuer URL. CostKey reads `/.well-known/openid-configuration` under it. |
| `COSTKEY_OIDC_CLIENT_ID` | Required. The client ID of the app you registered with the provider. |
| `COSTKEY_OIDC_CLIENT_SECRET` | Required. Its client secret. |
| `COSTKEY_OIDC_ALLOWED_DOMAINS` | Required. Email domains that may sign in, separated by commas, such as `example.com`. Use `*` to allow any email the provider has verified. |
| `COSTKEY_OIDC_SCOPES` | Optional. Default `openid email profile`. |
| `COSTKEY_OIDC_NAME` | Optional. The name on the button, such as `Okta`. |

Register `PUBLIC_URL` followed by `/auth/oidc/callback` as the redirect URI with your provider. For example, `https://costkey.example.com/auth/oidc/callback`.

| Provider | Issuer |
| --- | --- |
| Google Workspace | `https://accounts.google.com` |
| Okta | `https://<your-org>.okta.com`, or `https://<your-org>.okta.com/oauth2/default` for the default authorization server |
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant-id>/v2.0` |

CostKey uses the authorization code flow with PKCE, state and nonce. It verifies the ID token's signature, issuer, audience, nonce and expiry. When the provider says whether the email is verified, the email must be verified. On Entra ID, add the `email` optional claim to the app's token configuration.

### When something is wrong

The server log says what is missing or wrong, such as an unset `COSTKEY_IAP_AUDIENCE` or a rejected IAP header. A misconfigured SSO mode lets nobody sign in, but SDK ingest keeps working. An unknown `COSTKEY_AUTH` value stops the server at startup.

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

Pin a version with `COSTKEY_VERSION=0.7.0` in `.env`.

The server applies database migrations when it starts.

## Back up

Everything lives in the `costkey-postgres` volume. Back it up with:

```bash
docker compose exec postgres pg_dump -U costkey costkey > costkey-backup.sql
```

## What needs the internet

- **Prices.** The server syncs model prices every six hours from LiteLLM, models.dev and OpenRouter. The image includes a snapshot, so a fresh install has prices before its first sync.
- **Email and GitHub sign-in**, only if you set them up.
- **LLM judges.** [Quality checks](./quality-checks) that use a judge call the provider you pick (OpenAI, Anthropic or Google) from the server.

Calls from your app go straight to your providers. CostKey never sits in between.
