---
name: sandbox-toolchain
description:
  Node versions, local Postgres/Redis, Playwright browsers and blocked downloads in this sandbox.
  Use before installing a runtime, starting a database or running e2e tests.
---

# sandbox-toolchain

The sandbox has no Docker and no sudo, and outbound HTTPS only reaches an allowlist (GitHub, npm,
PyPI, nodejs.org, Prisma engines, the Playwright browser CDN, Google Fonts and the model APIs).
Don't spend turns on `docker compose`, `apt-get` or other registries; use what is below.

## Node

`node`, `npm`, `npx` and `corepack` follow the nearest `.nvmrc` or `.node-version` under
`/workspace`. The image carries Node 24 (default) and 26; check with `node --version`. Force a major
with `OI_NODE_MAJOR=26 <command>`. A major the image lacks falls back to 24; for an exact patch
release, download it from `https://nodejs.org/dist/` into `~/.local/share/node` and put its `bin`
first on `PATH`.

pnpm, yarn via corepack and other `#!/usr/bin/env node` tools run on the selected Node.

## Databases

Run a local stand-in instead of the repository's Docker service. Both listen on 127.0.0.1:

```bash
oi-services start postgres "$DATABASE_URL"   # Postgres 16 + pgvector; creates the URL's role and db
oi-services start redis                      # Redis on 6379
oi-services status
oi-services stop
```

Postgres trusts local connections, so any password in the URL works. `psql`, `pg_isready`,
`redis-cli` and `sqlite3` are on `PATH`. Ports: `OI_POSTGRES_PORT`, `OI_REDIS_PORT`. Postgres 16
stands in for a repository's 15 or 17 container; say so in your report when a test depends on a
version-specific feature.

## Playwright

Install the browsers the repository's Playwright version expects, without `--with-deps` (the system
libraries are already present):

```bash
npx playwright install chromium        # or firefox / webkit
```

Puppeteer uses the image's Chrome (`PUPPETEER_EXECUTABLE_PATH`); Cypress binary downloads are off
(`CYPRESS_INSTALL_BINARY=0`), so Cypress tests cannot run here.

## Still unavailable

MySQL, .NET, Java/Android SDKs and container images. Report tests you could not run and why instead
of skipping them silently.
