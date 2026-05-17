# CostKey

[![GitHub stars](https://img.shields.io/github/stars/costkey/platform?style=social)](https://github.com/costkey/platform)
[![TypeScript SDK](https://img.shields.io/npm/v/costkey?label=npm%20costkey)](https://www.npmjs.com/package/costkey)
[![Python SDK](https://img.shields.io/pypi/v/costkey?label=PyPI%20costkey)](https://pypi.org/project/costkey/)

CostKey is AI cost observability for production teams. It tells you which function, route, feature, customer, deploy, prompt, tool call, or agent run spent your AI budget.

```bash
npx costkey setup
# or
pipx run costkey setup
```

## Why It Exists

Provider dashboards tell you how much you spent. They do not tell you which line of code spent it.

CostKey connects AI spend back to the source code and product behavior that caused it:

- `generateSummary()` in `src/features/search.ts:47` spent `$1,200`
- `POST /api/search` triggers 4 model calls and 2 tool calls
- deploy `a1b2c3d` increased cost per request by 38%
- customer `cus_123` is driving 22% of spend
- an agent loop started retrying and crossed budget

No proxy. No provider migration. No wrapper-first rewrite.

## Product Surface

- **TypeScript SDK** - patches `fetch`, supports setup CLI, no-code preload, budgets, traces, prompt/tool metadata, sourcemaps, and custom providers.
- **Python SDK** - patches `httpx` and `requests`, supports setup CLI, FastAPI/Django/Flask detection, call graph analysis, traces, prompt/tool metadata, and custom providers.
- **Server** - ingests events, validates DSNs, calculates costs, filters stack traces, resolves sourcemaps, stores data in PostgreSQL.
- **Dashboard** - shows spend trends, cost by function, traces, event details, prompt/tool metadata, custom providers, budgets, alerts, and deploy comparisons.
- **Docs and landing** - static docs and marketing site deployed to Firebase.

## Repositories

| Repo | Purpose |
| --- | --- |
| [`costkey/platform`](https://github.com/costkey/platform) | SaaS app, server, dashboard, landing, docs, monorepo SDK copy |
| [`costkey/costkey`](https://github.com/costkey/costkey) | TypeScript SDK published to npm |
| [`costkey/costkey-python`](https://github.com/costkey/costkey-python) | Python SDK published to PyPI |

If you are using CostKey, starring the SDK repos helps other developers find it:

- [Star the TypeScript SDK](https://github.com/costkey/costkey)
- [Star the Python SDK](https://github.com/costkey/costkey-python)
- [Star the platform](https://github.com/costkey/platform)

## Quick Start

### TypeScript / Node.js

```bash
npx costkey setup
```

Manual entrypoint setup:

```ts
import { CostKey } from "costkey";

CostKey.init({
  dsn: process.env.COSTKEY_DSN,
});
```

No-code preload:

```bash
NODE_OPTIONS=--import costkey/register npm start
```

### Python

```bash
pipx run costkey setup
```

Manual entrypoint setup:

```py
import os
import costkey

costkey.init(dsn=os.environ["COSTKEY_DSN"])
```

No-code bootstrap:

```bash
PYTHONPATH="$PWD/.costkey:$PYTHONPATH" uvicorn app:app
```

## Architecture

```
Your app                  CostKey server              Dashboard
---------                 --------------              ---------
SDK patches fetch/httpx   ingest events               trends
detects AI providers      calculate cost              traces
captures stack traces     resolve sourcemaps          event detail
scrubs payloads           group call sites            budgets
ships async events        store in PostgreSQL         alerts
```

The SDKs never proxy provider traffic. AI calls still go directly from your app to OpenAI, Anthropic, Google, or your gateway. CostKey sends observability events in the background.

## Development

```bash
npm install
npm run dev
npm run build
npm test
```

Local services:

- server: `http://localhost:4100`
- dashboard: `http://localhost:5180`

## Deploy

Railway deploys the server/dashboard app:

```bash
railway up --service costkey-app --environment production
```

Firebase deploys the landing/docs site:

```bash
firebase deploy --only hosting --project costkey-dev
```

SDK publishing happens from GitHub Releases in the SDK repos, not from local machines.

## Release Checklist

For SDK releases:

1. Update version in the SDK repo.
2. Merge to `main`.
3. Create GitHub Release tag `vX.Y.Z`.
4. GitHub Actions runs tests/builds and publishes to npm or PyPI through trusted publishing.

For platform deploys:

1. Run `npm run build`.
2. Deploy Railway.
3. Deploy Firebase if landing/docs changed.
4. Smoke test `https://app.costkey.dev/auth/me` and `https://costkey-dev.web.app`.

## License

MIT
