# Atodotren

Milestone 0 establishes Atodotren's provider-neutral TypeScript and PostgreSQL runtime. It does not ingest Renfe data and does not contain a frontend.

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
checks the configured host port, a running primary container's health, migration
state/checksums when PostgreSQL is reachable, Git ignore coverage for `.env`, and
free disk space. PostgreSQL unavailability defers only the live database checks;
static local configuration is still validated. Less than 10 GiB free is a warning
and less than 2 GiB is a blocking failure.

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
npm run worker -- doctor
```

`worker doctor` validates environment parsing, the PostgreSQL wire connection, migration state, private schemas, least-privilege runtime membership, denied schema creation, and database clock skew. Feed and spool checks are emitted as `deferred` because those systems intentionally begin in later milestones.

## Commands

The CLI contract is visible with `npm run worker -- --help`. Milestone 0 implements only `worker doctor`. The planned `ingest`, `import-static`, `aggregate`, `finalize`, `replay`, and `report` commands exit nonzero with a structured `command.not_implemented` error.

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

The integration suite requires `TEST_ADMIN_DATABASE_URL`, `TEST_MIGRATOR_DATABASE_URL`, and `TEST_WORKER_DATABASE_URL`. It creates a uniquely named disposable database, validates hostile role-collision handling, migrates from empty, proves a second migration is clean, rotates the migration login, verifies ownership/default privileges and runtime permissions, runs `worker doctor`, and removes the disposable database. A missing database fails the suite explicitly; it is never silently skipped.

Run the complete supported-major contract in isolated disposable containers:

```sh
npm run test:postgres:matrix
```

Milestone 0 supports PostgreSQL 16 through 18. CI pins the current patch images `postgres:16.14-bookworm` (minimum) and `postgres:18.4-bookworm` (primary). A future managed provider's exact PostgreSQL major must pass this same contract suite before any migration is allowed.

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

Start the Milestone 0 Compose sequence. PostgreSQL becomes healthy, migrations complete, and the one-shot worker doctor runs inside the image:

```sh
docker compose --env-file .env up --build worker
```

Inspect state and logs, then stop safely:

```sh
docker compose --env-file .env ps -a
docker compose --env-file .env logs postgres migrate worker
docker compose --env-file .env down
```

Add `--volumes` to `down` only when you intentionally want to delete the local PostgreSQL data volume.

Run the isolated full Compose smoke test (it creates and removes its own project and volume):

```sh
npm run test:compose -- .env
```

The smoke project overrides `POSTGRES_PORT` with Docker's `0` (ephemeral) host
publication, so it never claims the primary stack's configured host port. Its
project name, containers, network, and volume are isolated and removed on success,
failure, `SIGINT`, or `SIGTERM`; the primary stack is neither stopped nor mutated.

## Diagnosing failures

- `config.invalid`: inspect the named environment keys. Values and credentials are not logged.
- PostgreSQL remains unhealthy: run `docker compose --env-file .env logs postgres`; check port conflicts and whether the initial passwords are present.
- Authentication fails after changing a password: PostgreSQL initialization scripts run only while creating a fresh data volume. Editing `.env` does not rotate a login password already stored in PostgreSQL. For local development, either restore the component value that matches the existing role or connect as the local administrator and explicitly run safe, targeted `ALTER ROLE ... PASSWORD ...` statements for only the affected login roles. If the local data is deliberately disposable, you may instead run `docker compose --env-file .env down --volumes` and initialize it again. That command destroys the local PostgreSQL volume and all of its data; it is never an ordinary restart command. Managed-provider credential rotation is a separate deployment procedure deferred to Milestone 6.
- A migration checksum mismatch: an already-applied migration was edited. Restore it and add a new ordered SQL migration instead.
- `doctor` reports permissions: confirm `DATABASE_URL` uses `atodotren_worker`, not the migration/admin credential, and rerun migrations with `MIGRATION_DATABASE_URL` using `atodotren_migrator`.
- A migration reports missing membership: the login must be granted `atodotren_migration_admin` with `ADMIN FALSE, INHERIT FALSE, SET TRUE`. Never grant that role to the runtime login.
- Docker is unavailable in WSL: enable the distribution under Docker Desktop's WSL integration settings. Container tests fail rather than report a skip.

All logs are newline-delimited JSON. The worker drains its PostgreSQL pool on normal completion, `SIGINT`, and `SIGTERM`, with a bounded shutdown timeout.

## Future managed PostgreSQL variables

No managed service is contacted by Milestone 0. For a future stock managed PostgreSQL deployment:

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

## Milestone 0 decisions

- npm workspaces were selected because npm ships with the pinned Node runtime and provides a reproducible `npm ci` lockfile workflow.
- Only packages needed by this milestone exist: configuration, observability, database, and worker. The web app and feed/domain packages are created when their milestone begins.
- SQL migrations are immutable, checksummed, transaction-scoped, and serialized with a PostgreSQL advisory lock. Kysely is reserved for typed application queries and raw SQL checks.
- All group roles are project-prefixed and `NOLOGIN`. Local Compose creates `atodotren_worker` with inherited, non-settable `atodotren_ingest_writer` membership and `atodotren_migrator` with non-inherited, set-only `atodotren_migration_admin` membership. Future migrations grant worker and monitor access per object instead of inheriting blanket write/read defaults.
- PostgreSQL 16 is the minimum supported major and PostgreSQL 18 is primary. Exact current patch tags were verified against the official multi-architecture registry manifests.
- PostgreSQL and Node container tags are pinned to patch releases that publish both `amd64` and `arm64` images.
