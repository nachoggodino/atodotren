# Atodotren

Milestone 5 CI readiness adds a provider-neutral reporting layer and a private,
read-only Telegram operations service to the accepted Milestone 4 evidence foundation.
The service is a separate portable container, uses least-privilege PostgreSQL reporting
credentials, and is prepared for a two-week Pi evidence pilot. The CI-readiness gate
runs the repository contract, strict TypeScript/lint/unit checks, stock PostgreSQL
16.14 and 18.4 contracts, native and amd64/arm64 image builds, and the isolated
fake-Telegram Compose smoke before this phase can be considered ready. This CI phase
does not deploy the pilot, select a managed provider, build the frontend, or accept
Milestone 5.

## Prerequisites

- Node.js 24.x and npm 11.x
- Docker Engine with Docker Compose v2 for PostgreSQL, image, and full-stack checks
- A POSIX shell for the supplied smoke-test script

The repository uses npm workspaces and exact external dependency versions. Application code uses Kysely over `node-postgres`; schema changes are ordered SQL files in `migrations/`.

## Local setup

```sh
cp example.env .env
```

Replace both placeholder passwords in `.env`. The local Compose bootstrap constructs its container URLs from those values, so use long alphanumeric/hyphen passwords without URL-reserved characters. Do not commit `.env`.

Protect the local file after editing it:

```sh
chmod 600 .env
```

Install and verify the TypeScript code:

```sh
npm ci
npm run preflight
npm run lint
npm run typecheck
npm run test:unit
```

`npm run preflight` is non-mutating. In local mode it checks Node.js/npm support,
Docker CLI/daemon/Compose/Buildx availability, required variables and unresolved
placeholders, all five PostgreSQL URLs, their expected local users/database/host/port,
and local-only component-password coherence without printing credentials. It also
inspects the primary container's actual `5432/tcp` publication, requires it to match
`POSTGRES_PORT`, checks container health and exact repository/database migration
synchronization, verifies Git ignore coverage for `.env`, and checks free disk space.
PostgreSQL unavailability is nonblocking only when no primary stack exists; an
unreachable migration URL for a healthy primary stack fails. Less than 10 GiB free
is a warning and less than 2 GiB is a blocking failure.

Start only the pinned primary stock PostgreSQL 18.4 container:

```sh
docker compose --env-file .env up -d --wait postgres
```

Apply explicit SQL migrations and run the health command from the host:

```sh
set -a
. ./.env
set +a
npm run db:migrate
npm run worker -- import-static --file tests/fixtures/gtfs-static/representative.zip
npm run worker -- doctor
```

`doctor` deliberately fails after migration until one valid Madrid static version
is active. The representative fixture contains a Madrid route and a colliding
non-Madrid `C-1` label; the latter is parsed and discarded, proving labels are not
used to infer the network.

`worker doctor` validates environment parsing, the PostgreSQL wire connection,
exact migration synchronization, private schemas, the complete least-privilege
runtime role graph, denied schema creation, database clock skew, and the active
Madrid static version with complete route/trip/stop mapping coverage. It reports
version/checksum/freshness/counts and its immediate predecessor. It also reports
configured realtime endpoints, the latest successful poll and freshness, SQLite
spool writability/size/pending/dropped counts, and heartbeat configuration.

## Commands

The CLI contract is visible with `npm run worker -- --help`. Milestone 5 implements
`worker report` in addition to the accepted ingestion, canonicalization, aggregation,
finalization, replay and doctor commands. `worker report` emits stable bounded JSON by
default or concise text with `--text`. Legacy worker Telegram delivery is disabled at
the Milestone 5 CLI boundary; SMTP compatibility remains, while `telegram-ops` is the
sole Telegram Bot API sender. Usage errors exit `2`; runtime failures exit `1`.

## Realtime ingestion

Production defaults to RENFE's protobuf feeds at `trip_updates.pb`,
`vehicle_positions.pb`, and `alerts.pb`. Trip updates and vehicle positions run
in the same non-overlapping 30-second cycle; alerts run every 60 seconds. Each
endpoint has a validated URL and independent enable flag in `example.env`.

Run continuously, once, or for a bounded number of cycles:

```sh
npm run worker -- ingest --canonical-maintenance
npm run worker -- ingest --once
npm run worker -- ingest --cycles 2
```

Requests time out after 10 seconds, responses are capped at 32 MiB, and one
transient network/timeout/5xx failure is retried after 3–5 seconds of jitter.
4xx responses are not retried. Feed-generation, vehicle-observation, and local
capture timestamps remain distinct. `DIFFERENTIAL` feeds fail explicitly rather
than being treated as snapshots.

Only uniquely matched Madrid entities are persisted. Matching tries the active
static version, then its immediate predecessor; route/start-time fallback must
produce exactly one trip. `stop_sequence` takes precedence over `stop_id` for
repeated stops. Arrival time and signed arrival delay are retained independently;
departure-only data and propagated predictions are not historical evidence.
Cancellation, skipped-stop, and first STOPPED_AT presence evidence use distinct
classifications. Identical predictions and repeated stopped presence update no
append-only row, while live vehicle positions replace current state.

The in-memory matching cache is tagged with the active/previous feed-version
identity and replaced when either identity changes. A warm cache remains usable
during a PostgreSQL outage. A cold worker that cannot load its first static index
records or spools a compact `static.index_unavailable` failed poll and retries
later; it does not count a discarded national feed as a successful matching cycle.

## Canonical journeys

`core.journey` identifies a resolved trip instance by network, service date, exact
static feed version, source trip, and optional start time. `core.journey_stop`
contains every scheduled arrival call from that exact version, including calls
with no realtime evidence. Both are daily partitions on `service_date`; the
bounded partition helper covers 30 completed service days plus an operational
buffer without deleting anything.

Canonical stop statuses are:

- `pending`: the journey is open and the stop has no stop-specific evidence.
- `reported_only`: Renfe supplied arrival time and/or signed delay but there is no
  captured `STOPPED_AT` presence.
- `observed_presence`: at least one valid `STOPPED_AT` observation exists. Its
  first timestamp is immutable; reported arrival fields remain alongside it.
- `skipped`: an explicit stop-level `SKIPPED` transition. Earlier predictions are
  retained for explanation, but the stop is excluded from later delay distributions.
- `canceled`: explicit trip cancellation covers this not-yet-completed stop. With
  no completed stop it covers the full route; otherwise the conservative cutoff
  is the greatest sequence with captured stopped presence.
- `missing_evidence`: assigned only at closure to a still-pending stop. Feed
  disappearance is never interpreted as cancellation.

Skipped, canceled, and missing stops never receive fabricated zero delay. A
defensibly matched `arrival.time` selects its exact signed difference from the
scheduled instant; otherwise Renfe's signed `arrival.delay` is the fallback. Both
inputs and their discrepancy remain independently inspectable as integer seconds,
including negative values. A live delay propagated downstream is never persisted
as historical stop evidence.

GTFS-Realtime `start_date` is authoritative. Evidence without a defensible service
date cannot create a journey; date provenance remains provided, explicitly
inferred, or unavailable. Schedule conversion interprets service date plus integer
GTFS seconds in the network IANA timezone (`Europe/Madrid`) and stores UTC
`timestamptz`. Thus `25:00:00` lands on the next civil day. A nonexistent spring
wall time moves forward by the DST gap; an ambiguous fall time selects the later
standard-time occurrence, matching PostgreSQL `AT TIME ZONE` deterministically.
Across retained evidence, provenance is selected independently and deterministically:
provided service dates outrank inferred dates, and exact matching outranks fallback
matching. A stronger later observation upgrades an open journey and all stop lineage.

Run a bounded pass, rebuild open data for a disposable/test date, close eligible
journeys with a two-hour grace, or explicitly repair closed data:

```sh
npm run worker -- canonicalize --limit 100
npm run worker -- canonicalize --service-date 2026-08-22 --rebuild
npm run worker -- close-journeys --limit 100 --grace-seconds 7200
npm run worker -- repair-journeys --service-date 2026-08-22 \
  --algorithm-version canonical-v2 --repair-version 1 --reason correction-ticket-123
```

Canonicalization takes a transaction-scoped advisory lock per journey and performs
no network I/O. Newer predictions replace older ones; identical and stale evidence
is counted and ignored. Explicit cancellation may close immediately. Otherwise
closure occurs only after the timezone-derived scheduled end plus grace, including
after-midnight services. Closed rows reject ordinary updates; repair must increase
the repair version, change the algorithm version, and record a reason. Repair work
is discovered from existing closed journeys, not from evidence rows. If their
retained evidence is unavailable, the report contains `repair_evidence_unavailable`
and the command exits nonzero. Because changed stop evidence is retained for seven
days, ordinary repairability is likewise limited to that seven-day window; evidence
must be preserved separately before attempting an older correction. Repeated
bounded repair calls skip journeys already at the requested version and continue
through the date; repairable journeys are processed before expired-evidence errors.
Commands emit concise JSON reports.

The Compose worker runs `worker ingest --canonical-maintenance`. Every polling cycle
performs bounded canonicalization and closure; every five minutes the same deployed
process also recomputes dirty aggregates and invokes bounded finalization/month
sealing. Automatic finalization searches the oldest eligible dates in the retained
35-day canonical/timetable window, not only the most recent week. Repeated failures
emit one warning incident and a recovery event without stopping realtime ingestion.
Retention deletion remains deliberately manual and two-stage. Manual
commands remain available for inspection, recovery, and explicit repairs.

Inspect one journey and every stop's explanation:

```sql
SELECT j.service_date, j.source_trip_id, j.lifecycle_status,
       j.feed_version_id, j.matching_method, j.canonical_algorithm_version,
       s.stop_sequence, s.source_stop_id, s.station_id,
       s.scheduled_arrival_at, s.renfe_arrival_at,
       s.renfe_arrival_delay_seconds, s.derived_delay_seconds,
       s.delay_discrepancy_seconds, s.selected_delay_seconds,
       s.selected_delay_source, s.first_stopped_presence_at,
       s.evidence_status, s.evidence_selected_captured_at
FROM core.journey AS j
JOIN core.journey_stop AS s
  ON s.service_date = j.service_date AND s.journey_id = j.id
WHERE j.service_date = DATE '2026-08-22' AND j.source_trip_id = 'source-trip-id'
ORDER BY s.stop_sequence;
```