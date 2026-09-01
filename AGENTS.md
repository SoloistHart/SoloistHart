# AGENTS.md

## Cursor Cloud specific instructions

This repository is a **GitHub profile README** (`soloisthart-profile`), not a web application. There is no `dev` server, database, Docker stack, or npm application dependencies.

### What runs locally

| Command | Purpose |
| --- | --- |
| `npm install` | Initializes the npm project (zero runtime deps; lockfile only) |
| `npm run update:readme` | Fetches public repos from GitHub API and refreshes the featured-projects table in `README.md` |
| `node scripts/update-metrics.mjs` | Regenerates `github-metrics.svg` via GitHub GraphQL (requires a token) |

CI uses **Node.js 20** (see `.github/workflows/update-profile.yml`). Node 20+ works; the scripts use only built-in Node APIs (`fetch`, `fs`).

### Environment variables

| Variable | Required for | Notes |
| --- | --- | --- |
| `GITHUB_TOKEN` | `update:readme` (optional), `update-metrics.mjs` (required) | Unauthenticated API works for public readme refresh but is rate-limited (~60 req/hr) |
| `METRICS_TOKEN` | Metrics in CI | CI skips metrics generation when unset |
| `GITHUB_USERNAME` | Both scripts | Defaults to `SoloistHart` |
| `FEATURED_TOPIC` | `update:readme` | Defaults to `featured` |

### Lint / test

There are no `lint` or `test` npm scripts. Validate scripts with:

```bash
node --check scripts/update-readme.mjs
node --check scripts/update-metrics.mjs
```

### End-to-end validation

1. Run `npm run update:readme` and confirm the `<!-- featured-projects:start -->` block in `README.md` updates.
2. Optionally run `node scripts/update-metrics.mjs` with `GITHUB_TOKEN` or `METRICS_TOKEN` set.
3. Preview static assets (`assets/soloist-hart-hero.svg`, `github-metrics.svg`) or view the live profile at https://github.com/SoloistHart.

### Gotchas

- `update:readme` writes to `README.md` in place; revert or commit intentionally after local runs.
- `update-metrics.mjs` queries the **authenticated viewer** via GraphQL, so the token owner’s stats are used (not necessarily `GITHUB_USERNAME` for contribution data).
