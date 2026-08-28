# Atodotren MVP Implementation Plan

Status: data foundation Milestones 0–4 accepted; Milestone 5 operational pilot acceptance remains separate; frontend implemented with public acceptance still pending
Scope: Madrid Cercanías evidence foundation plus a read-only bilingual public-accountability PWA
Working name: Atodotren

The detailed foundation-era plan previously stored at this path is retained verbatim in [`docs/MVP_IMPLEMENTATION_PLAN_FOUNDATION.md`](docs/MVP_IMPLEMENTATION_PLAN_FOUNDATION.md). This document is now the active plan and records the architecture and acceptance boundary after the frontend was introduced.

## 1. Product outcome

Atodotren continuously records defensible Madrid Cercanías delay evidence and turns it into a public, reproducible view of current and accumulated performance.

The product serves two related needs:

1. a commuter can answer “what is happening to my line/station now?” without pretending feed-derived state is GPS;
2. a citizen, journalist or researcher can investigate persistent delay patterns with visible coverage, freshness, uncertainty and methodology.

Spanish is the default locale and English is fully supported.

## 2. Non-negotiable evidence rules

The accepted data-foundation rules remain authoritative:

- Madrid only during the MVP;
- PostgreSQL is the source of truth and remains stock/provider-neutral;
- browser code never receives database credentials;
- `arrival.time`, `arrival.delay`, captured `STOPPED_AT`, propagated predictions, cancellations, skipped calls and missing evidence remain distinct concepts;
- a propagated live delay never becomes historical evidence;
- punctual means selected arrival delay `<= 120` seconds;
- delays are stored/calculated as integer seconds and rounded only for display;
- outages and missing evidence reduce coverage rather than disappearing from denominators;
- exact recent journey/matrix detail follows the 30-day retention boundary;
- older history is served from verified aggregate facts.

## 3. System boundary

```text
RENFE static/realtime
       │
       ▼
portable TypeScript worker
       │              └── bounded local SQLite outage spool
       ▼
stock PostgreSQL 16–18
       │
       ├── aggregation/finalization/retention
       ├── private read-only Telegram operations
       └── api schema
             │
             ▼
      atodotren_web_reader
             ▲
             │ exact sole membership
       atodotren_web login
             │
             ▼
        Next.js server
             │
             ▼
        bilingual public PWA
```

No Supabase/browser database SDK, provider Data API or direct Pi database exposure belongs in the frontend architecture.

## 4. Repository boundaries

```text
apps/
  worker/                  ingestion, maintenance and operations CLI
  web/                     Next.js PWA + public JSON boundary
packages/
  canonical-journeys/
  config/
  db/
  gtfs-realtime/
  gtfs-static/
  observability/
migrations/                ordered immutable SQL migrations
docker/
  worker/
  web/
docs/                      retained detailed foundation/operations material
```

`apps/web/src` is layered so presentation components do not own SQL, database rows, translations or API construction. The server service layer is shared directly by Server Components and route handlers.

## 5. Database roles and public contract

Existing project-prefixed group roles remain `NOLOGIN` and unsafe attributes are rejected.

Frontend adds the runtime login `atodotren_web` with exactly one direct membership:

```text
atodotren_web -> atodotren_web_reader
ADMIN FALSE / INHERIT TRUE / SET FALSE
```

The web login receives only approved `api` schema privileges. It cannot select private source/canonical/aggregate/operations tables or assume another project role.

Migrations `0001`–`0012` are immutable. Frontend work adds new ordered migrations for:

- bounded catalog/history public views and functions;
- exact web-reader grants/default-deny behavior;
- bounded live/journey/schematic read contracts.

All important inputs have bounded result limits/date windows and parameter validation. Public models use stable slugs/public identifiers rather than internal sequence IDs.

## 6. Public metadata contract

Every relevant model exposes enough metadata for the UI to state what it knows rather than imply certainty. Depending on the read, that includes:

- generated timestamp;
- source/freshness timestamp;
- live/paused/stale/outage/cached state;
- coverage/sample size;
- finalized versus unfinalized status;
- exact/approximate/inferred precision or algorithm explanation;
- stable locale-independent identifiers.

Cache policy follows the evidence lifecycle:

- live: about 30 seconds;
- current/unfinalized aggregates: short, about five minutes;
- finalized history: at least one hour;
- static/versioned catalog/layout: long-lived and version-aware.

Server Components call the service layer directly and never self-fetch `/api/v1`.

## 7. Frontend architecture

Use:

- Next.js 16 App Router;
- React 19;
- strict TypeScript;
- Tailwind CSS 4;
- Server Components by default;
- Recharts for conventional charts;
- custom accessible SVG for the schematic network;
- semantic HTML/CSS grid for the timetable matrix;
- bounded TanStack Virtual rendering for measured large-matrix pressure;
- CSS transitions and reduced-motion fallbacks;
- a small consistent icon set.

Do not add a general animation framework. Virtualization is intentionally limited to the large timetable-matrix axes already covered by bounded-DOM browser acceptance; smaller surfaces should remain unvirtualized until measurements justify otherwise.

Design direction and concrete tokens live in [`DESIGN.md`](DESIGN.md). The UI combines:

- Civic Flow on landing/overview;
- Transit Canvas for live schematic state;
- Evidence Ledger for historical analysis.

Flat editorial composition is the default. Cards are reserved for independently actionable, selectable, stateful or portable blocks.

## 8. Localization and routing

Stable routes:

```text
/[lang]
/[lang]/live
/[lang]/live/line/[slug]
/[lang]/live/station/[slug]
/[lang]/history
/[lang]/history/line/[slug]
/[lang]/history/station/[slug]
/[lang]/methodology
```

`lang` is `es` or `en`, with Spanish the default redirect. Copy belongs in typed dictionaries, not inline component literals except non-user-facing technical constants. Meaningful filters and selections are reflected in query parameters so an investigation URL can be shared.

## 9. Fixture and PostgreSQL modes

Two explicit adapters implement the same UI contracts:

```text
WEB_DATA_MODE=fixture
WEB_DATA_MODE=postgres
```

Fixture scenarios cover healthy, partial coverage, stale, outage, overnight, cancellation, missing evidence, incomplete current day, finalized historical data, ambiguous/empty search and offline states.

A production runtime refuses fixture mode unless the explicit private-preview override is supplied. Ordinary frontend CI and visual review use fixtures and contact no production/Pi/managed database.

PostgreSQL mode uses `WEB_DATABASE_URL` server-side only with a small dedicated pool and bounded statement timeout.

## 10. Landing

The landing page provides:

- centrally replaceable brand/symbol;
- concise accountability statement;
- train/schematic visual language;
- unified line/station search with `C1`/`C-1` normalization;
- ambiguity handling;
- explicit live/today and historical actions;
- methodology/data-source access.

It can be more expressive than analytical pages without becoming card-heavy.

## 11. Live views

Live begins with the all-lines overview and supports line/station context.

Required behavior:

- visible freshness and coverage;
- default 30-second refresh;
- global persisted pause/resume control in the floating menu;
- hidden tabs suspend polling and refresh once when visible;
- refresh preserves prior content;
- today performance plus compact historical comparison;
- delay distribution;
- topology-aware schematic SVG;
- keyboard-operable clickable trains;
- train details with scheduled/probable/reported evidence, cancellation/skip/missing state, freshness and confidence.

Schematic placement is explicitly feed-derived/inferred, never labelled GPS.

## 12. Historical views

Historical analysis supports network, line and station views with available date/range, weekday, hour and direction filters.

Expose:

- punctuality;
- mean/median and delay distributions;
- sample volume and coverage;
- worst lines/stations/hours with minimum-sample safeguards;
- temporal evolution;
- selected-day timetable matrix for line detail.

Matrix cells display scheduled time and distinguish measured delay, canceled, skipped, missing and not-yet-observed. They are keyboard focusable, expose row/column/grid semantics and provide concise detail. Text/symbol semantics accompany color. Large matrices retain a bounded DOM through the accepted virtualization policy.

The exact matrix remains a recent-detail feature governed by the 30-day policy.

## 13. Methodology

The bilingual methodology page explains in plain language:

- Renfe GTFS/static and GTFS-Realtime inputs;
- reported versus calculated delay;
- punctuality at `<=120s`;
- propagated live predictions;
- cancellations, skipped calls and missing evidence;
- coverage and incomplete days;
- aggregation/finalization/retention;
- histogram/median approximation where used;
- schematic position limitations;
- public-accountability purpose.

## 14. PWA/offline contract

Installable standalone behavior includes a manifest, replaceable placeholder icons and a small versioned service worker.

Offline storage is intentionally limited to:

- application shell;
- last important successful live selection;
- one useful daily summary.

Do not cache complete history or matrices. Cached answers must be explicitly identified as cached/offline; the service worker retains cache timestamps as response metadata for diagnostics, but the compact offline banner does not need to surface that timestamp. When no approved cache entry exists, show an explicit no-cache offline state. Update cache names/versioning safely.

## 15. Accessibility and responsive behavior

Target WCAG 2.2 AA:

- keyboard operation and visible focus;
- focus restoration for the floating menu;
- inert hidden drawer content;
- screen-reader labels/summaries and grid structure for timetable matrices;
- color never as the sole state carrier;
- reduced-motion support;
- responsive mobile/desktop layouts;
- longer English copy tested alongside Spanish.

The floating navigation adapts the proven Termómetro interaction architecture: in-place expansion, hamburger morph and mobile hide-on-scroll/reveal, without copying its reporting or Supabase coupling. A small shell-owned scroll coordinator records route positions so pathname-changing forward navigation starts at the top while browser Back/Forward restores the destination route's previous position.

## 16. Verification strategy

Proportionate unit tests cover normalization/aliases, URL/filter parsing, delay/state formatting, metadata/freshness derivation, translations, adapter contract parity and persisted theme/refresh preferences.

PostgreSQL 16.14 and 18.4 contracts cover:

- exact web role membership;
- approved result contracts;
- bounded date/result queries;
- denial of private table access;
- representative query timing.

Browser tests cover:

- landing search and selection, including stale-query invalidation;
- line/station navigation and browser scroll restoration;
- refresh pause/resume persistence;
- keyboard train details;
- historical filters and matrix keyboard/grid behavior;
- Spanish/English;
- light/dark;
- mobile/desktop;
- reduced motion;
- offline cached/no-cache scenarios;
- automated accessibility smoke;
- bounded DOM and interaction for virtualized large matrices.

CI also builds standalone worker and web images for amd64 and amd64/arm64 where the existing image strategy supports it cleanly.

## 17. Milestone status

### Milestones 0–4 — accepted

Repository/runtime, static Madrid foundation, realtime evidence, canonical journeys, and aggregation/retention are accepted. Their detailed implementation/acceptance history is retained in the archived foundation plan.

### Milestone 5 — operational pilot remains separate

The reporting/Telegram CI implementation exists, but final pilot acceptance still depends on intended local/Pi operation and measured evidence. Frontend work does not silently convert that implementation readiness into pilot acceptance.

### Frontend — implemented, acceptance ongoing

Implemented scope:

1. web workspace, public read API, web role and typed contracts;
2. design system and floating application shell;
3. landing/search and fixture scenarios;
4. live overview/line/station/schematic/train detail;
5. historical views, temporal filters and bounded timetable matrices;
6. PWA/offline boundary, accessibility, responsive polish, CI/container verification.

The implementation is present on `main`; ongoing frontend feature branches refine it without changing the acceptance boundary. Public acceptance still requires all relevant GitHub Actions gates green plus actual browser inspection and the representative managed-data checks below.

### Managed deployment — deferred

Before public deployment:

- select the managed PostgreSQL provider/plan from measured pilot requirements;
- run the complete role/migration/public-read contract against its exact PostgreSQL major/configuration;
- configure TLS/pooling/backups/restore monitoring;
- migrate/replay through supported paths;
- benchmark representative data with `EXPLAIN (ANALYZE, BUFFERS)`;
- deploy the public web image against only the managed read endpoint.

The Pi database is never made public as an expedient frontend backend.

## 18. Frontend acceptance measurements

Do not infer production performance from fixture rendering. Record separately:

- public query latency and plans on representative accumulated data;
- live/network/line/station server response timings;
- matrix source-query timing at its maximum supported recent window;
- bounded-DOM matrix browser behavior at representative maximum width/height;
- web production build output and container build success;
- mobile/desktop browser inspection findings;
- offline/PWA behavior on intended devices.

Additional virtualization, indexes, animation frameworks or provider-specific features are introduced only in response to measured need.

## 19. Explicitly deferred

- final managed PostgreSQL provider/plan;
- public deployment and DNS;
- final production identity/assets if the working brand changes;
- expansion beyond Madrid;
- user accounts/social features/subscriptions;
- public raw-data API;
- caching of full history or matrices;
- geographic/GPS train-map claims;
- virtualization outside the measured large-matrix surfaces without new performance evidence.

This ordering keeps the UI a consumer of the evidence model rather than a reason to weaken it.
