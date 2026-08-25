# Atodotren

Atodotren is an independent, bilingual public-accountability project for Madrid Cercanías. It records Renfe GTFS and GTFS-Realtime evidence, builds defensible canonical journeys and long-lived delay aggregates, and exposes the result through a read-only public PWA.

The public interface is deliberately evidence-first: freshness, coverage, incomplete data, finalization and precision remain visible instead of being hidden behind a single reliability score. Live train placement is schematic and feed-derived; it is never presented as GPS.

## Repository status

- Milestones 0–4: accepted data foundation.
- Milestone 5: CI implementation/readiness for reporting and private Telegram operations is complete; the Pi/local pilot acceptance remains a separate operational gate.
- Frontend alpha: implemented on `feature/frontend-alpha` and subject to CI, browser/visual review and later representative managed-database acceptance. A green implementation CI does not by itself accept the frontend.
- Migrations `0001`–`0012` are immutable. Frontend public-read work begins with `0013`.

The detailed historical worker/database operations guide that previously occupied this README is retained verbatim in [`docs/FOUNDATION_OPERATIONS.md`](docs/FOUNDATION_OPERATIONS.md). The current milestone plan is [`MVP_IMPLEMENTATION_PLAN.md`](MVP_IMPLEMENTATION_PLAN.md), and the frontend visual contract is [`DESIGN.md`](DESIGN.md).

## Architecture

```text
RENFE GTFS + GTFS-Realtime
          │
          ▼
  TypeScript ingestion worker ──► bounded SQLite outage spool
          │
          ▼
   stock PostgreSQL 16–18
          │
          ├── private operational/reporting roles
          │
          └── api schema ──► atodotren_web_reader
                                  ▲
                                  │ exact sole membership
                             atodotren_web
                                  │
                                  ▼
                         Next.js server only
                                  │
                                  ▼
                         browser / installable PWA
```

The browser never receives PostgreSQL credentials and never connects to PostgreSQL or a provider SDK. Server Components and JSON route handlers call the same service layer directly; Server Components do not self-fetch internal API routes.

### Web stack

`apps/web` uses:

- Next.js 16 App Router and React 19;
- strict TypeScript;
- Tailwind CSS 4 with CSS-first semantic tokens;
- Server Components by default and narrow client boundaries for interaction, refresh, theme, charts and menus;
- Recharts for ordinary charts;
- purpose-built accessible SVG for the schematic network;
- semantic HTML/CSS for the timetable matrix;
- CSS transitions with reduced-motion support;
- `pg` server-side only, with fixture and PostgreSQL adapters implementing the same UI contracts.

Brand name, wordmark and train symbol are centralized so they can be replaced without searching through presentation components.

## Public routes

Spanish is the default locale and English is supported from the same typed message contract.

```text
/es                         /en
/es/live                    /en/live
/es/live/line/c1            /en/live/line/c1
/es/live/station/atocha     /en/live/station/atocha
/es/history                 /en/history
/es/history/line/c1         /en/history/line/c1
/es/history/station/atocha  /en/history/station/atocha
/es/methodology             /en/methodology
```

Historical selections and supported filters are encoded in the URL. Exact timetable matrices remain bounded by the existing 30-day detailed-data policy.

The stable JSON boundary lives under `/api/v1`, including catalog search, live network/line/station/journey reads, historical network/line/station reads and the recent timetable matrix. Responses use UI-oriented models rather than database rows and carry freshness/coverage/finalization/precision metadata where relevant.

## Local prerequisites

- Node.js 24.x
- npm 11.x
- Docker Engine + Docker Compose v2 for PostgreSQL/container verification
- a POSIX shell for repository scripts

Install exactly the committed dependency graph:

```sh
npm ci
```

The root lockfile covers all npm workspaces, including `apps/web`. CI regenerates a lockfile candidate with the pinned npm version and requires it to be byte-for-byte current before any application verification runs.

## Environment

Start from the documented template:

```sh
cp example.env .env
chmod 600 .env
```

Use distinct local values for at least:

- `POSTGRES_PASSWORD`
- `ATODOTREN_WORKER_PASSWORD`
- `ATODOTREN_TELEGRAM_PASSWORD`
- `ATODOTREN_WEB_PASSWORD`

Do not commit `.env`.

The web server has an independent provider-neutral wire URL:

```text
WEB_DATABASE_URL=postgresql://atodotren_web:...@host:5432/atodotren
```

`atodotren_web` must have exactly one direct membership: `atodotren_web_reader` with inherited access, no admin option and no `SET ROLE` path. Public migrations grant that reader only approved `api` objects. It cannot select private `core`, `ingest`, `analytics`, `operations` or `gtfs_static` tables directly.

## Frontend data modes

### Deterministic fixture mode

Fixture mode is the default developer/visual-review workflow and never contacts a real database:

```sh
WEB_DATA_MODE=fixture npm run web:dev
```

Useful scenarios include healthy live data, partial coverage, stale feed, outage, overnight/no-active-trains, cancellations, missing observations, incomplete current day, finalized history, ambiguous/empty search and offline cached/no-cache behavior.

A production runtime rejects fixture mode. The explicit `WEB_ALLOW_FIXTURE_PRODUCTION=true` escape hatch exists only for private deterministic previews, CI and the isolated fixture Compose stack.

Start the standalone fixture container:

```sh
docker compose -f compose.web-fixture.yaml up --build
```

### Local PostgreSQL mode

Bootstrap roles, apply migrations and provide a real local `WEB_DATABASE_URL`:

```sh
docker compose --env-file .env up -d --wait postgres
docker compose --env-file .env run --rm role-bootstrap
docker compose --env-file .env run --rm migrate
WEB_DATA_MODE=postgres npm run web:dev
```

The frontend alpha does not contact a managed database, production service or Pi database during ordinary verification.

## Web commands

```sh
npm run web:dev
npm run web:typecheck
npm run web:lint
npm run web:test
npm run web:build
npm run web:test:e2e
```

The existing worker/database commands remain documented in [`docs/FOUNDATION_OPERATIONS.md`](docs/FOUNDATION_OPERATIONS.md).

## Live behavior

Live reads default to a 30-second refresh interval. The floating application menu exposes a global pause/resume switch; that preference persists locally. Hidden tabs suspend polling and refresh once after becoming visible again. A local refresh preserves the previous rendered content instead of replacing the page with a route-level skeleton.

The live schematic uses explicit topology/layout configuration rather than geographic coordinates. Train placement can be associated with a stop or interpolated between schematic stops, but UI copy labels that position as feed-derived/inferred. Detail views keep delay in integer seconds internally and format it only for presentation.

## Historical behavior

Historical views expose punctuality at the project threshold (`delay <= 120 seconds`), mean/median delay, distributions, volume, coverage, rankings and temporal evolution. Rankings apply minimum-sample safeguards instead of promoting tiny samples as meaningful extremes.

The selected-day matrix is stops × scheduled trains. Applicable cells always expose the scheduled time and use separate semantic states for measured delay, canceled, skipped, missing evidence and not-yet-observed. Cells are keyboard focusable and their state is communicated through text/symbols as well as color.

## PWA and offline boundary

The PWA includes a manifest, replaceable placeholder icons and a small versioned service worker. Offline caching is deliberately narrow:

- application shell;
- the last important successful live selection;
- one useful daily summary.

It does **not** cache the complete historical dataset or timetable matrices. Cached content is explicitly labelled with its cache timestamp; when no approved cached answer exists, the user gets a clear offline/no-cache state. Service-worker updates use versioned caches rather than silently mixing incompatible data.

## Verification

The frontend alpha extends, rather than replaces, the existing gates:

- repository whitespace/credential/migration immutability contract;
- worker strict typecheck, lint and unit tests;
- web strict typecheck, lint, unit tests and Next production build;
- PostgreSQL 16.14 and 18.4 worker contracts;
- PostgreSQL 16.14 and 18.4 public-web role/query/permission contracts;
- Playwright fixture smoke on desktop and mobile Chromium;
- Spanish/English, light/dark, reduced-motion, keyboard and accessibility smoke;
- bounded offline cached/no-cache scenarios;
- worker amd64 and amd64/arm64 image builds;
- standalone web amd64 and amd64/arm64 image builds;
- isolated fake-feed/fake-Telegram Compose smoke.

The PostgreSQL web contract also records a small representative query timing rather than claiming performance from design alone. Larger real-data query-plan budgets remain part of managed/representative-data acceptance.

## Acceptance boundary

The alpha is not product-accepted merely because implementation CI is green. Before a public deployment, still perform and record:

1. browser visual review with representative data at mobile/desktop and light/dark sizes;
2. managed PostgreSQL role/bootstrap verification against the provider's exact supported major;
3. representative-data query plans and latency measurements;
4. final brand/icon replacement if the working identity changes;
5. production PWA/install/offline checks on intended devices;
6. confirmation that the public deployment reaches only the managed read endpoint and never exposes the Pi database.

No frontend-alpha code is merged to `main` by this branch workflow.
