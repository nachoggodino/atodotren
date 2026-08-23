# Atodotren

Milestone 4 adds deterministic historical aggregates, timetable-complete opportunity
denominators, service-day verification, monthly sealing, and explicitly authorized
retention to the accepted static, realtime, and canonical-journey foundation. A train
that never appears in realtime is materialized from the applicable GTFS timetable and
counted as missing evidence. The project does not yet build a public API,
managed-provider deployment, or a frontend.

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

The CLI contract is visible with `npm run worker -- --help`. Milestone 4
implements `worker doctor`, `worker import-static`, `worker ingest`,
`worker replay`, `worker canonicalize`, `worker close-journeys`,
`worker repair-journeys`, `worker aggregate`, `worker finalize`, and the opt-in
`worker test-notifications`. Usage errors exit `2`;
configuration, acquisition, validation, database, and runtime failures exit `1`;
a successful import or explicit HTTP/checksum unchanged result exits `0`. The
later `report` command remains unimplemented. Command dispatch is import-safe.

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

Inspect a 30-day station/train matrix:

```sql
SELECT s.service_date, j.line_id, j.source_trip_id, s.stop_sequence,
       s.station_id, s.scheduled_arrival_at, s.renfe_arrival_at,
       s.selected_delay_seconds, s.evidence_status
FROM core.journey_stop AS s
JOIN core.journey AS j
  ON j.service_date = s.service_date AND j.id = s.journey_id
WHERE s.station_id = 1 AND s.service_date >= current_date - 30
ORDER BY s.service_date DESC, j.scheduled_start_at, s.stop_sequence;
```

`renfe_arrival_at` is Renfe's reported expected-arrival instant, not an exact
physical arrival timestamp. `first_stopped_presence_at` proves only captured
presence at the stop and never replaces the reported arrival field.

Inspect recent poll quality:

```sql
SELECT feed_kind, captured_at, feed_header_timestamp, result_class,
       matched_madrid_count, non_madrid_count, unmatched_count, invalid_count,
       evidence_changed_count, evidence_repeated_count, response_bytes,
       response_duration_ms, persistence_duration_ms
FROM ingest.poll_run
ORDER BY captured_at DESC
LIMIT 20;
```

Detailed poll and quarantine rows target 30 days, Madrid-filtered compressed
payloads 48 hours, and changed stop evidence seven days. Evidence deletion is
blocked until every matching journey is finalized, its evidence watermark covers
the partition, and the current canonical checksum still matches a verified service
day. Known partitions are then handled through the authorization workflow below.

## Aggregation, finalization, and retention operations

Daily aggregation is deterministic replacement, never incremental arithmetic.
Finalization materializes all applicable static timetable trips first, so total
realtime outages reduce coverage instead of disappearing from the denominator.
Before any canonical rows are created, an independent expected-day ledger is built
from the complete preferred active/previous timetable. The whole day remains blocked
until its final scheduled journey plus grace has elapsed, and finalization verifies
journey/stop totals and a stable metric-identity checksum against that ledger. The
checksum covers line, branch, direction, service pattern, station, stop order, and
scheduled time while allowing equivalent active/previous feed lineage.

Exact-schedule daily contributions retain raw GTFS service-day seconds and separately
derive Europe/Madrid civil date, weekday, and 0–86,399 wall-clock seconds. Optional
rows in `operations.calendar_classification` provide published, versioned holiday
overrides; migration `0007` seeds the 2026 Comunidad de Madrid regional calendar
from its official calendar publication. Otherwise days classify as `weekend` or
`ordinary_weekday` under `calendar-v1`. Successful sealing compacts these rows into
monthly classified facts with no row identity, service date, or civil date. A blocked
sealing attempt writes no monthly classified rows.

A day with polls but zero successful Renfe responses finalizes as `incomplete` and
remains visible in its denominator. After operational confirmation, acknowledge it
explicitly so the month can seal with an `incomplete_acknowledged` quality flag:

```sh
npm run worker -- finalize --service-date 2026-08-22 \
  --acknowledge-incomplete "confirmed complete Renfe outage"
```

Safe bounded examples:

```sh
npm run worker -- aggregate --limit 20
npm run worker -- aggregate --service-date 2026-08-22
npm run worker -- finalize --service-date 2026-08-22
npm run worker -- finalize --month 2026-08-01
npm run worker -- finalize --retention
npm run worker -- finalize --authorize-retention
```

`--retention` is a read-only plan. `--authorize-retention` records checksummed
authorization but deletes nothing. Re-run the plan and inspect `blockers`, source
row counts, checksums, and exact partition names before the destructive second stage:

```sh
npm run worker -- finalize --apply-retention \
  --confirm-retention DROP-VERIFIED-PARTITIONS
```

Never automate the confirmation literal. If a plan changes after authorization,
the checksum gate blocks application and a fresh authorization is required. Recovery
is restore-from-backup or replay of separately preserved source evidence; dropped
partitions are not reconstructed from monthly aggregates.

## SQLite spool, heartbeat, and alerts

The Node 24 built-in SQLite queue stores normalized pending writes, never national
protobuf bodies. It is FIFO and replay-safe, defaults to a 1 GiB hard limit, is
capped at 10 GiB, and rejects logical backlog older than 48 hours. Under pressure
it drops replaceable vehicle positions first and records exact reasons/counts.
Compose mounts it at `/spool/realtime.sqlite` on the `realtime-spool` volume.

Inspect and explicitly replay it:

```sh
npm run worker -- doctor
npm run worker -- replay
docker compose --env-file .env run --rm --no-deps worker replay
```

`HEARTBEAT_URL` is optional and is called only after a successful fetch plus
durable PostgreSQL or spool persistence. Telegram (`TELEGRAM_BOT_TOKEN` plus
`TELEGRAM_CHAT_ID`) and SMTP (`SMTP_HOST`, `SMTP_FROM`, `SMTP_TO`, with optional
credentials) are independent. Each incident key is a sequence of independent
episodes. An episode normally sends ACTIVE once after three consecutive bad
observations; a pending episode that recovers earlier closes silently. RECOVERY is
sent once, and only through channels that delivered ACTIVE for that episode. A
new episode starts at occurrence one without inheriting prior notification state.
Partial delivery is tracked per channel in the running worker, so a successful
Telegram delivery is not repeated while only a failed SMTP delivery is retried.
`heartbeat.failure` covers failed delivery attempts and is observed healthy after
the next successful delivery; `heartbeat.stale` separately covers elapsed time
without a success. Ordinary tests use fake transports and never send messages.

Matching-collapse alerts add hysteresis without changing the 2% aggregate
acceptance gate: entry requires `INGEST_ALERT_FAILURE_THRESHOLD` consecutive
observations below `INGEST_MATCHING_RATE_MINIMUM` (defaults 3 and 0.02), while
recovery requires `INGEST_MATCHING_RECOVERY_THRESHOLD` consecutive observations
above `INGEST_MATCHING_RATE_RECOVERY_MINIMUM` (defaults 3 and 0.05). The recovery
boundary must be greater than the entry boundary.

Incident metadata failures and channel failures emit credential-safe structured
`notification.*_failed` events while durable RENFE ingestion continues. Per-channel
delivery state is retained while failed database markers retry on later
observations; zero-row state updates are treated as failures. Retry state remains
process-local: a crash after a channel send but before its database marker can
rarely duplicate that delivery. A durable per-channel outbox is deferred to
Milestone 6.

Explicitly test the configured real channels from the built Compose worker only
when sending a labelled test message and heartbeat is intended:

```sh
docker compose --env-file .env run --rm --no-deps worker \
  test-notifications --confirm-send
```

The command reports Telegram, SMTP, and heartbeat as delivered, failed, or
skipped and exits nonzero if a configured channel fails. It never creates an
operational incident or prints credentials. `ATODOTREN_NOTIFICATION_TEST=1` is an
alternative explicit opt-in; the command refuses to send without one of these
confirmations.

## Static Madrid import

The default command conditionally requests the RENFE Cercanías archive. It sends
an active version's `ETag` and `Last-Modified` only when that version's canonical
source URL equals the URL currently being requested:

```sh
npm run worker -- import-static
npm run worker -- import-static --json
```

`--force-recheck` omits conditional headers, but SHA-256 idempotency still prevents
a duplicate successful version. An explicit override must be HTTPS (HTTP is
accepted only for loopback test servers):

```sh
npm run worker -- import-static --url https://example.invalid/recovery.zip --json
```

For deterministic recovery or offline testing, use a local ZIP:

```sh
npm run worker -- import-static --file /absolute/path/to/fomento_transit.zip
```

The concise report includes fetch validators/status, checksum/archive bytes,
parsed/retained/discarded counts, stable-dimension coverage, warnings, activation,
current/previous IDs, and bounded timings. `--json` emits exactly one report on
stdout; operational shutdown logs go to stderr.

An external scheduler can invoke the one-shot command daily at approximately
04:00 Europe/Madrid:

```cron
TZ=Europe/Madrid
0 4 * * * cd /srv/atodotren && docker compose --env-file .env run --rm --no-deps static-import import-static --json
```

Each run is serialized in PostgreSQL. A failed or interrupted candidate rolls
back; validation/archive failures record compact rejected-version metadata and
leave the active version untouched.

Inspect the active and immediate previous versions:

```sql
SELECT id, sha256, activated_at, previous_feed_version_id, import_report
FROM gtfs_static.current_feed_version
WHERE network_slug = 'madrid';
```

Diagnose bounded rejection metadata without source rows or credentials:

```sql
SELECT id, fetched_at, rejection_code, rejection_message, validation_report
FROM gtfs_static.feed_version
WHERE status = 'rejected'
ORDER BY fetched_at DESC
LIMIT 20;
```

Confirm complete Madrid mapping coverage:

```sql
SELECT
  (SELECT count(*) FROM gtfs_static.route r WHERE r.feed_version_id = v.id) AS routes,
  (SELECT count(*) FROM gtfs_static.route_line_map m WHERE m.feed_version_id = v.id) AS mapped_routes,
  (SELECT count(*) FROM gtfs_static.trip t WHERE t.feed_version_id = v.id) AS trips,
  (SELECT count(*) FROM gtfs_static.trip_pattern_map m WHERE m.feed_version_id = v.id) AS mapped_trips
FROM gtfs_static.current_feed_version v
WHERE v.network_slug = 'madrid';
```

Acquisition is bounded to 256 MiB compressed, 1.5 GiB total declared/decompressed,
1 GiB for `stop_times.txt`, 1 MiB per CSV record, 64 entries, and 750,000 retained
Madrid stop times. HTTP content, recognized extracted entries, and intermediate
files live only in a private temporary directory and are removed on every exit.
Provision at least 2 GiB temporary free space; `GTFS_STATIC_TEMP_DIR` can place it
on a dedicated local volume. The national ZIP, unrelated entries, national rows,
and raw source records are never stored in PostgreSQL or logs.

Ordinary CI never contacts RENFE. Make the single bounded external download into
disposable local PostgreSQL explicitly:

```sh
ATODOTREN_REAL_STATIC_SMOKE=1 npm run test:real-static
```

The smoke fails clearly on external dependency or mapping drift, verifies zero
routes outside the explicit Madrid route-prefix rule and no unrelated dependency
facts, prints compact JSON plus station/memory audits, and removes its disposable
database and transient archive.

Live verification on 2026-08-17 imported the official 16,126,979-byte archive
(`e5375ed3d52984e0670089b01bbd4ce2823ada56b51b100af7e0c7e9108670a3`) in
25.709 seconds with peak Node RSS of 563,140 KiB (about 550 MiB). It retained 118
Madrid routes, 37,503 trips, 95 stops, 533,783 stop times, 30 calendar services,
23 shapes, and 11,777 shape points. These produced 16 stable lines, 65 branches,
120 service patterns, and 1,249 directed segments. Every route/trip/stop mapping
was covered; queries found zero routes or trips outside source prefix `10` and zero
unreferenced stops, services, or shapes. `worker doctor` succeeded against the
activated version before the disposable database and national ZIP were removed.

The live feed declares the single feed agency `1071VC`, while `routes.txt` omits
`agency_id`; Madrid is explicitly encoded by route IDs beginning `10`. RENFE pads
CSV records and the final header field, so headers are trimmed before validation.
The feed also contains 39 Madrid trip rows without stop times, two with one stop,
and one service pattern with a consecutive repeated terminal call. The importer
reports and discards the 41 zero-length trip fragments. It preserves both versioned
terminal stop-time rows while collapsing the repeated canonical station only in
stable topology, preventing a meaningless self-segment.

The same live archive's 1,162 national stop rows expose only `stop_id`, name,
coordinates, and accessibility: there is no `stop_code`, `parent_station`,
`location_type`, or platform hierarchy. Therefore the current canonical rule is
configured alias first, then `stop_code` when a future feed supplies one, then the
explicit RENFE `stop_id` fallback. All 95 retained stop IDs mapped one-to-one to
95 stable stations; display names are never used for merging.

Run migrations:

```sh
npm run db:migrate
```

Run the PostgreSQL integration suite against the local container:

```sh
set -a
. ./.env
set +a
npm run test:integration
```

The integration suite requires `TEST_ADMIN_DATABASE_URL`, `TEST_MIGRATOR_DATABASE_URL`, and `TEST_WORKER_DATABASE_URL`. It creates a uniquely named disposable database and covers hostile role attributes and membership graphs, migration rollback/checksum/missing-file failures, advisory-lock release and concurrency, login rotation, ownership/default privileges, exact doctor migration state, runtime permissions, fixture import, checksum idempotency, changed-version activation, rejected/database-failed rollback, previous-version availability, concurrent serialization, and zero non-Madrid persistence before removing the database. A missing database fails explicitly; it is never silently skipped.

Run the complete supported-major contract in isolated disposable containers:

```sh
npm run test:postgres:matrix
```

Atodotren supports PostgreSQL 16 through 18. CI pins the current patch images `postgres:16.14-bookworm` (minimum) and `postgres:18.4-bookworm` (primary). A future managed provider's exact PostgreSQL major must pass this same contract suite before any migration is allowed.

## Container and Compose

Build the host-architecture worker image:

```sh
npm run docker:build
```

Build an OCI archive containing both target platforms (this does not push an image):

```sh
npm run docker:build:multiarch
```

The archive is written to the ignored file `atodotren-worker-multiarch.tar`. If the local default Buildx driver cannot export multiple platforms, create a container-backed builder first with `docker buildx create --driver docker-container --use`.

TypeScript compilation runs on the build platform, while `npm ci --omit=dev` runs
separately on each target platform. The spool uses Node 24's built-in SQLite, so
Milestone 4 introduces no third-party native addon; both architectures still run
their own production dependency installation.

Start the ordinary Milestone 4 Compose sequence. PostgreSQL becomes healthy,
migrations complete, `static-import` uses its configured URL (or the default
official RENFE source), the bounded spool volume is initialized, and continuous
ingestion starts only after a real active version exists:

```sh
docker compose --env-file .env up --build worker
```

Inspect state and logs, then stop safely:

```sh
docker compose --env-file .env ps -a
docker compose --env-file .env logs postgres migrate static-import worker
docker compose --env-file .env down
```

Add `--volumes` to `down` only when you intentionally want to delete the local PostgreSQL data volume.

Run the isolated full Compose smoke test (it creates and removes its own project and volume):

```sh
npm run test:compose -- .env
```

The smoke script adds the test-only `compose.smoke.yaml` override. It bind-mounts
the representative ZIP read-only and starts deterministic local protobuf feeds.
It proves the declared startup chain, bounded polling, changed-evidence
deduplication, worker restart, PostgreSQL interruption, SQLite queuing, recovery,
ordered replay, no duplicate evidence, no national filtered payload, and doctor.
It overrides `POSTGRES_PORT` with Docker's `0` (ephemeral) host publication, so it
never claims the primary stack's configured host port. Its project name, containers,
network, and volume are isolated and removed on success, failure, `SIGINT`, or
`SIGTERM`; the primary stack is neither stopped nor mutated.

Run the opt-in bounded real RENFE smoke (one static download and two realtime
cycles by default) only when external access is intended:

```sh
ATODOTREN_REAL_REALTIME_SMOKE=1 npm run test:real-realtime
```

It uses disposable local PostgreSQL and a temporary spool, prints per-feed bytes,
timings, match classifications, evidence/live/alert counts, verifies empty replay
and Madrid-only filtered payloads, and cleans all transient data. Ordinary CI does
not contact RENFE.

The bounded run on 2026-08-17 verified that all three official defaults were live
GTFS-Realtime 2.0 `FULL_DATASET` protobuf feeds. Two cycles made six successful
requests totaling 168,792 bytes: 48 Madrid matches, 136 clear non-Madrid entities,
682 unmatched entities, and zero malformed entities. They produced 12 changed
evidence rows, suppressed 12 identical repeats, and left six current vehicles and
12 current alerts. The compressed retained Madrid subset was 4,724 bytes; no
national protobuf or clear national entity was stored. The SQLite spool remained
empty and an explicit replay inserted nothing. This short observation does not
establish feed completeness or satisfy the unattended gate.

Many national trip and vehicle descriptors in the observed feed omitted
`route_id`. They are therefore counted as unmatched and discarded, not guessed as
non-Madrid. The default matching-collapse floor is conservatively 2% for this
national-feed denominator and remains configurable with
`INGEST_MATCHING_RATE_MINIMUM`. The completed 48-hour run measured 31.30%
aggregate matching, so the alert correction does not alter matching logic or
this gate.

The unattended acceptance gate is intentionally separate from implementation
verification. A future evidence run can use:

```sh
ATODOTREN_ACCEPTANCE_HOURS=48 npm run accept:realtime -- .env
```

The script samples container CPU/memory and spool peak, then reports poll coverage,
matching/fallback/ambiguous/malformed rates, changed versus repeated evidence,
relation/index sizes, endpoint failures, incident/recovery state, and heartbeat
state. It leaves the stack running for inspection and exits nonzero if the worker
is no longer running, the derived minimum poll count is missed, successful poll
coverage is below 90%, matching/malformed thresholds fail, the spool is nonempty
or has dropped operations, or a notified incident remains unresolved. Pending,
below-threshold episodes remain in the report for diagnosis but do not fail the
gate. Resource samples are JSON records; invalid Docker zero-memory readings fall
back to the container cgroup, or are explicitly marked unavailable. The default
minimum poll count is 90% of the polls implied by enabled feeds, configured
intervals, and run duration. Useful overrides are `ATODOTREN_ACCEPTANCE_MIN_POLLS`,
`ATODOTREN_ACCEPTANCE_MIN_POLL_RATIO`,
`ATODOTREN_ACCEPTANCE_MIN_SUCCESS_COVERAGE`,
`ATODOTREN_ACCEPTANCE_MIN_MATCHING_RATE`, and
`ATODOTREN_ACCEPTANCE_MAX_MALFORMED_RATE`. Matching and malformed defaults come
from `INGEST_MATCHING_RATE_MINIMUM` and `INGEST_MALFORMED_RATE_MAXIMUM`.

The command uses the Compose `postgres-data` and `realtime-spool` named volumes
and deliberately leaves both, plus the running stack, available for inspection.
The accepted run produced 14,384 polls with 99.74% successful coverage, 31.30%
aggregate Madrid matching, 0.01% malformed entities, zero ambiguous matches,
161,793 changed evidence rows, and 435,726 identical repeats suppressed. It ended
with no spool backlog or dropped operations and used approximately 185 MB across
realtime ingest/operations relations. No second 48-hour run is required for the
notification correction.

`scripts/pi-resource-monitor.sh` remains a temporary acceptance-only host helper,
not a production alerting system. It reads only its Telegram settings from the
resolved Compose configuration, does not query PostgreSQL with administrator
credentials, and records delivery state only in memory; that state is lost when
the script restarts.

## Diagnosing failures

- `config.invalid`: inspect the named environment keys. Values and credentials are not logged.
- PostgreSQL remains unhealthy: run `docker compose --env-file .env logs postgres`; check port conflicts and whether the initial passwords are present.
- Authentication fails after changing a password: PostgreSQL initialization scripts run only while creating a fresh data volume. Editing `.env` does not rotate a login password already stored in PostgreSQL. For local development, either restore the component value that matches the existing role or connect as the local administrator and explicitly run safe, targeted `ALTER ROLE ... PASSWORD ...` statements for only the affected login roles. If the local data is deliberately disposable, you may instead run `docker compose --env-file .env down --volumes` and initialize it again. That command destroys the local PostgreSQL volume and all of its data; it is never an ordinary restart command. Managed-provider credential rotation is a separate deployment procedure deferred to Milestone 6.
- A migration checksum mismatch: an already-applied migration was edited. Restore it and add a new ordered SQL migration instead.
- `doctor` reports permissions: confirm `DATABASE_URL` uses `atodotren_worker`, not the migration/admin credential, and rerun migrations with `MIGRATION_DATABASE_URL` using `atodotren_migrator`.
- `doctor` reports no active static version: inspect recent rejected metadata, correct the mapping/source problem, then run `worker import-static` with a changed/fixed ZIP. A rejected checksum is not silently retried as a new version.
- `feeds.realtime` is stale: inspect `ingest.poll_run`, endpoint enable/URL values, and worker logs. A configured endpoint can be disabled independently if RENFE withdraws it.
- Spool growth or replay failure: run `worker doctor`, preserve the spool volume, restore PostgreSQL, then run `worker replay`; do not delete the SQLite file while entries remain.
- `archive.*`, `csv.*`, `mapping.*`, or `canary.*`: use the bounded error code and counts in the import report; raw national records are intentionally unavailable.
- A migration reports missing membership: the login must be granted `atodotren_migration_admin` with `ADMIN FALSE, INHERIT FALSE, SET TRUE`. Never grant that role to the runtime login.
- Docker is unavailable in WSL: enable the distribution under Docker Desktop's WSL integration settings. Container tests fail rather than report a skip.

All logs are failure-safe newline-delimited JSON with recursive error normalization,
credential/connection-URL redaction, circular-reference handling, and protected
envelope fields. Shutdown remains bounded and LIFO, attempts every cleanup after a
failure, safely closes resources registered during shutdown, and deliberately forces
termination on a second signal.

## Future managed PostgreSQL variables

No managed service is contacted by this implementation or its tests. For a future stock managed PostgreSQL deployment:

- `DATABASE_URL`: the small-pool, long-lived worker wire URL using the `atodotren_ingest_writer` login/membership.
- `MIGRATION_DATABASE_URL`: a direct or session connection with schema/role administration rights. It may equal `DATABASE_URL` only in local development; never use the migration credential at runtime.
- `DATABASE_SSL_MODE`: `require` for encrypted transport without CA verification, or `verify-full` for certificate and hostname verification. Local Compose uses `disable` only on its private Docker network/localhost.
- `DATABASE_CA_CERT_PATH`: absolute path to a PEM CA bundle; required by this runtime when `DATABASE_SSL_MODE=verify-full`.
- `DATABASE_POOL_MAX`, `DATABASE_CONNECTION_TIMEOUT_MS`, `DATABASE_IDLE_TIMEOUT_MS`, and `DATABASE_STATEMENT_TIMEOUT_MS`: provider-neutral pool/query bounds.

Connection strings must be ordinary `postgres://` or `postgresql://` URLs. There are no provider SDKs, Data APIs, authentication products, required extensions, or application tables in `public`. The browser will never connect to PostgreSQL directly.

### Migration-login bootstrap and rotation

The cluster/database administrator performs the one-time bootstrap: create or validate the five project-prefixed `NOLOGIN` roles, revoke `public` schema access, and grant database `CREATE` to `atodotren_migration_admin`. Local Compose performs this in `docker/postgres/init/001-runtime-roles.sh`.

For a replacement migration login, first create a safe `LOGIN NOINHERIT` role with no elevated attributes, then grant only set-only membership:

```sql
GRANT atodotren_migration_admin TO replacement_migrator
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
```

After changing `MIGRATION_DATABASE_URL`, run `npm run db:migrate`. The runner rejects incorrect membership and executes every pending migration under `SET LOCAL ROLE atodotren_migration_admin`; application objects and default privileges therefore remain owned by the stable project role rather than the replaceable login or provider administrator.

## Foundation decisions

- npm workspaces were selected because npm ships with the pinned Node runtime and provides a reproducible `npm ci` lockfile workflow.
- Packages through Milestone 4 exist: configuration, observability, database,
  static GTFS, GTFS-Realtime, canonical journeys, worker, and SQL analytics and
  retention contracts. The web app remains deferred to a later milestone.
- SQL migrations are immutable, checksummed, transaction-scoped, and serialized with a PostgreSQL advisory lock. Kysely is reserved for typed application queries and raw SQL checks.
- All group roles are project-prefixed and `NOLOGIN`. Local Compose creates `atodotren_worker` with only inherited, non-settable `atodotren_ingest_writer` membership and `atodotren_migrator` with only non-inherited, set-only `atodotren_migration_admin` membership. Group roles cannot be members of any other role, and both runner and doctor reject direct or transitive graph drift. Future migrations grant worker and monitor access per object instead of inheriting blanket write/read defaults.
- `npm run build` and test compilation remove their generated output first; `npm run clean` removes application, package, script, and test output so deleted sources cannot leave executable artifacts behind.
- PostgreSQL 16 is the minimum supported major and PostgreSQL 18 is primary. Exact current patch tags were verified against the official multi-architecture registry manifests.
- PostgreSQL and Node container tags are pinned to patch releases that publish both `amd64` and `arm64` images.
- Every GTFS source key is scoped by immutable feed version. Stable product dimensions use network-scoped public slugs; no public route depends on an identity sequence.
- The live RENFE archive identifies its sole feed agency as `1071VC`; its routes omit `agency_id`. Madrid assignment uses the verified source route-ID prefix `10`, never the public line label. Station aliases prefer configuration, then `stop_code`, with an explicit version-mapping fallback to `stop_id`; collisions reject instead of guessing. Adding another network is expected to require a focused mapping/code addition, but not a database redesign.
- Successful static facts cannot be updated or deleted by the worker. The worker receives only selected inserts, stable-dimension upserts, lifecycle updates, reads, sequences, and a fixed security-definer `ANALYZE` function compatible with PostgreSQL 16.
