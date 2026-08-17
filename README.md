# Atodotren

Milestone 1's bounded, provider-neutral Madrid static-GTFS importer is accepted
against both the deterministic fixture and the current official RENFE feed. It
does not ingest GTFS-Realtime and does not contain a frontend.

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
version/checksum/freshness/counts and its immediate predecessor. GTFS-Realtime and
the outage spool remain explicitly deferred to Milestone 2.

## Commands

The CLI contract is visible with `npm run worker -- --help`. Milestone 1
implements `worker doctor` and `worker import-static`. Usage errors exit `2`;
configuration, acquisition, validation, database, and runtime failures exit `1`;
a successful import or explicit HTTP/checksum unchanged result exits `0`. The
later `ingest`, `aggregate`, `finalize`, `replay`, and `report` commands remain
unimplemented. Command dispatch is import-safe.

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

TypeScript compilation runs on the build platform, while `npm ci --omit=dev` runs separately on each target platform. Native production dependencies are therefore built for `amd64` or `arm64`, including the future SQLite spool dependency.

Start the ordinary Milestone 1 Compose sequence. PostgreSQL becomes healthy,
migrations complete, `static-import` uses its configured URL (or the default
official RENFE source), and the one-shot worker doctor runs only after a real
active version exists:

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
the representative ZIP read-only and replaces only the static-import command and
canaries; the production image and ordinary `compose.yaml` contain no fixture.
Its first path uses the declared `docker compose up worker` dependency chain:
healthy PostgreSQL, successful migration, fixture import, then worker doctor.
It overrides `POSTGRES_PORT` with Docker's `0` (ephemeral) host publication, so it
never claims the primary stack's configured host port. Its project name, containers,
network, and volume are isolated and removed on success, failure, `SIGINT`, or
`SIGTERM`; the primary stack is neither stopped nor mutated.

## Diagnosing failures

- `config.invalid`: inspect the named environment keys. Values and credentials are not logged.
- PostgreSQL remains unhealthy: run `docker compose --env-file .env logs postgres`; check port conflicts and whether the initial passwords are present.
- Authentication fails after changing a password: PostgreSQL initialization scripts run only while creating a fresh data volume. Editing `.env` does not rotate a login password already stored in PostgreSQL. For local development, either restore the component value that matches the existing role or connect as the local administrator and explicitly run safe, targeted `ALTER ROLE ... PASSWORD ...` statements for only the affected login roles. If the local data is deliberately disposable, you may instead run `docker compose --env-file .env down --volumes` and initialize it again. That command destroys the local PostgreSQL volume and all of its data; it is never an ordinary restart command. Managed-provider credential rotation is a separate deployment procedure deferred to Milestone 6.
- A migration checksum mismatch: an already-applied migration was edited. Restore it and add a new ordered SQL migration instead.
- `doctor` reports permissions: confirm `DATABASE_URL` uses `atodotren_worker`, not the migration/admin credential, and rerun migrations with `MIGRATION_DATABASE_URL` using `atodotren_migrator`.
- `doctor` reports no active static version: inspect recent rejected metadata, correct the mapping/source problem, then run `worker import-static` with a changed/fixed ZIP. A rejected checksum is not silently retried as a new version.
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
- Only packages needed through Milestone 1 exist: configuration, observability, database, static GTFS, and worker. The web app and realtime/domain packages are created when their milestone begins.
- SQL migrations are immutable, checksummed, transaction-scoped, and serialized with a PostgreSQL advisory lock. Kysely is reserved for typed application queries and raw SQL checks.
- All group roles are project-prefixed and `NOLOGIN`. Local Compose creates `atodotren_worker` with only inherited, non-settable `atodotren_ingest_writer` membership and `atodotren_migrator` with only non-inherited, set-only `atodotren_migration_admin` membership. Group roles cannot be members of any other role, and both runner and doctor reject direct or transitive graph drift. Future migrations grant worker and monitor access per object instead of inheriting blanket write/read defaults.
- `npm run build` and test compilation remove their generated output first; `npm run clean` removes application, package, script, and test output so deleted sources cannot leave executable artifacts behind.
- PostgreSQL 16 is the minimum supported major and PostgreSQL 18 is primary. Exact current patch tags were verified against the official multi-architecture registry manifests.
- PostgreSQL and Node container tags are pinned to patch releases that publish both `amd64` and `arm64` images.
- Every GTFS source key is scoped by immutable feed version. Stable product dimensions use network-scoped public slugs; no public route depends on an identity sequence.
- The live RENFE archive identifies its sole feed agency as `1071VC`; its routes omit `agency_id`. Madrid assignment uses the verified source route-ID prefix `10`, never the public line label. Station aliases prefer configuration, then `stop_code`, with an explicit version-mapping fallback to `stop_id`; collisions reject instead of guessing. Adding another network is expected to require a focused mapping/code addition, but not a database redesign.
- Successful static facts cannot be updated or deleted by the worker. The worker receives only selected inserts, stable-dimension upserts, lifecycle updates, reads, sequences, and a fixed security-definer `ANALYZE` function compatible with PostgreSQL 16.
