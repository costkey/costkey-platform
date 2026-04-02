---
sidebar_position: 6
title: Self-Hosting
description: Run CostKey on your own infrastructure with Docker.
---

# Self-Hosting

CostKey is fully open-source. You can run the server and dashboard on your own infrastructure. All data stays on your machines.

## Docker

The simplest way to self-host is with the included Dockerfile. The server serves both the API and dashboard from a single container.

```bash
git clone https://github.com/costkey/costkey.git
cd costkey
docker build -t costkey .
docker run -p 4100:4100 \
  -e DATABASE_URL=postgres://user:pass@host:5432/costkey \
  -e COSTKEY_JWT_SECRET=your-secret-here \
  costkey
```

The dashboard is available at `http://localhost:4100` and the API at `http://localhost:4100/api/v1/`.

## docker-compose

For a complete setup with PostgreSQL included:

```yaml
version: "3.8"

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: costkey
      POSTGRES_USER: costkey
      POSTGRES_PASSWORD: costkey
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    restart: unless-stopped

  costkey:
    build: .
    ports:
      - "4100:4100"
    environment:
      - NODE_ENV=production
      - PORT=4100
      - DATABASE_URL=postgres://costkey:costkey@postgres:5432/costkey
      - COSTKEY_JWT_SECRET=change-this-in-production
    depends_on:
      - postgres
    restart: unless-stopped

volumes:
  pgdata:
```

```bash
docker compose up -d
```

## Environment variables

| Variable | Required | Default | Description |
|----------|:--------:|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string. Format: `postgres://user:pass@host:5432/dbname` |
| `PORT` | No | `4100` | HTTP port for the server |
| `COSTKEY_JWT_SECRET` | Yes | — | Secret for signing JWT auth tokens. Use a random 32+ character string. |
| `NODE_ENV` | No | `development` | Set to `production` for production deployments |
| `COSTKEY_DATA_DIR` | No | — | Directory for file-based data storage (SQLite fallback when no DATABASE_URL) |

## Database setup

CostKey uses PostgreSQL. The server automatically creates all required tables on first startup — no migrations to run manually.

Minimum PostgreSQL version: 14.

### Connection string examples

```bash
# Local PostgreSQL
DATABASE_URL=postgres://costkey:costkey@localhost:5432/costkey

# Railway
DATABASE_URL=postgres://user:pass@host.railway.app:5432/railway

# Supabase
DATABASE_URL=postgres://postgres.xxxxx:pass@aws-0-us-east-1.pooler.supabase.com:6543/postgres

# Neon
DATABASE_URL=postgres://user:pass@ep-xxx.us-east-2.aws.neon.tech/costkey?sslmode=require
```

## Railway one-click deploy

CostKey includes a `railway.json` for one-click deployment on Railway:

1. Fork the [costkey/costkey](https://github.com/costkey/costkey) repository
2. Create a new project on [Railway](https://railway.com)
3. Add a **PostgreSQL** service
4. Add a new service from your forked GitHub repo
5. Set environment variables:
   - `DATABASE_URL` — Railway provides this automatically when you link the PostgreSQL service
   - `COSTKEY_JWT_SECRET` — generate a random string
   - `PORT` — set to `4100`
6. Deploy

The included `railway.json` configures the build and start commands:

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "Dockerfile"
  },
  "deploy": {
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

## Configuring the SDK

Point your SDK's DSN to your self-hosted server:

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

<Tabs>
<TabItem value="python" label="Python">

```python
import costkey

costkey.init(dsn="https://ck_your_key@your-server.example.com/your_project_id")
```

</TabItem>
<TabItem value="typescript" label="TypeScript">

```typescript
import { CostKey } from 'costkey'

CostKey.init({ dsn: 'https://ck_your_key@your-server.example.com/your_project_id' })
```

</TabItem>
</Tabs>

The DSN format is `https://<auth-key>@<host>/<project-id>`. The SDK parses this to determine the ingest endpoint (`<host>/api/v1/events`) and auth credentials.

## Health check

The server exposes a health endpoint at `/health`:

```bash
curl http://localhost:4100/health
# {"status":"ok","version":"0.1.0"}
```

## Reverse proxy

If you put CostKey behind nginx or another reverse proxy, make sure to:

1. Forward the `Authorization` header (used by SDKs for auth)
2. Allow request bodies up to 5MB (the server's JSON limit)
3. Set appropriate timeouts for long-running requests

Example nginx configuration:

```nginx
server {
    listen 80;
    server_name costkey.example.com;

    location / {
        proxy_pass http://localhost:4100;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 5m;
    }
}
```

## Updating

To update to the latest version:

```bash
git pull origin main
docker compose build
docker compose up -d
```

The server runs database migrations automatically on startup, so no manual migration step is needed.
