from pathlib import Path


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{path}: expected one exact documentation anchor, found {count}')
    path.write_text(text.replace(old, new, 1), encoding='utf-8')


readme = Path('README.md')
plan = Path('MVP_IMPLEMENTATION_PLAN.md')
workflow = Path('.github/workflows/ci.yml')

replace_once(
    readme,
    'Replace both placeholder passwords in `.env`. The local Compose bootstrap constructs its container URLs from those values, so use long alphanumeric/hyphen passwords without URL-reserved characters. Do not commit `.env`.',
    'Replace all three placeholder passwords in `.env` (`POSTGRES_PASSWORD`, `ATODOTREN_WORKER_PASSWORD`, and `ATODOTREN_TELEGRAM_PASSWORD`). The local Compose bootstrap constructs its container URLs from those values, so use long alphanumeric/hyphen passwords without URL-reserved characters. Do not commit `.env`.',
)
replace_once(
    readme,
    '''Docker CLI/daemon/Compose/Buildx availability, required variables and unresolved
placeholders, all five PostgreSQL URLs, their expected local users/database/host/port,
and local-only component-password coherence without printing credentials. It also
inspects the primary container's actual `5432/tcp` publication, requires it to match
`POSTGRES_PORT`, checks container health and exact repository/database migration
synchronization, verifies Git ignore coverage for `.env`, and checks free disk space.
PostgreSQL unavailability is nonblocking only when no primary stack exists; an
unreachable migration URL for a healthy primary stack fails.''',
    '''Docker CLI/daemon/Compose/Buildx availability, required variables and unresolved
placeholders, all seven PostgreSQL URLs (`DATABASE_URL`, `MIGRATION_DATABASE_URL`,
`REPORT_DATABASE_URL`, and the four `TEST_*_DATABASE_URL` values), their expected local
users/database/host/port, and component-password coherence without printing credentials.
After migration 0009 is applied, it also connects through `REPORT_DATABASE_URL` and
requires `atodotren_telegram` to have exactly one direct membership:
`atodotren_reporting_reader` with `ADMIN FALSE`, inherited access, and no `SET ROLE`
path. It also inspects the primary container's actual `5432/tcp` publication, requires
it to match `POSTGRES_PORT`, checks container health and exact repository/database
migration synchronization, verifies Git ignore coverage for `.env`, and checks free
disk space. PostgreSQL unavailability is nonblocking only when no primary stack exists;
an unreachable URL for a healthy primary stack fails.''',
)
replace_once(
    readme,
    '''```sh
docker compose --env-file .env up -d --wait postgres
```

Apply explicit SQL migrations and run the health command from the host:''',
    '''```sh
docker compose --env-file .env up -d --wait postgres
```

### Existing Milestone 4 PostgreSQL volume upgrade

PostgreSQL init scripts run automatically only when a data directory is created. They do
**not** rerun for the retained Milestone 4 `postgres-data` volume, so migration 0009 must
not be attempted on that volume until the new reporting roles are bootstrapped explicitly.
Take and verify a database/volume backup before the schema upgrade. Do not run
`docker compose down --volumes`, recreate the volume, or delete PostgreSQL data as part of
this procedure.

With the retained volume and the intended existing passwords still configured in the
ignored `.env`, run:

```sh
docker compose --env-file .env up -d --wait postgres
docker compose --env-file .env run --rm role-bootstrap
docker compose --env-file .env run --rm migrate
npm run preflight
```

`role-bootstrap` executes the same `docker/postgres/init/001-runtime-roles.sh` contract as
a fresh installation. It creates only missing roles/logins, validates role attributes and
exact direct memberships, and is safe to repeat. It never alters the password of an
existing login: changing `ATODOTREN_TELEGRAM_PASSWORD` or another component variable does
not silently rotate PostgreSQL credentials. A mismatch must be corrected deliberately,
not by destroying the volume. `migrate` runs only after bootstrap succeeds, and `preflight`
then verifies the reporting login/membership through `REPORT_DATABASE_URL`.

For rollback, preserve the retained volume and application configuration first. Disabling
`telegram-ops` rolls back the application service without removing data; there is no
in-place down migration for 0009 in this phase. If the database schema itself must be
rolled back, restore the verified pre-upgrade backup. Never use volume deletion as an
ordinary rollback mechanism.

Apply explicit SQL migrations and run the health command from the host:''',
)
replace_once(
    readme,
    'The integration suite requires `TEST_ADMIN_DATABASE_URL`, `TEST_MIGRATOR_DATABASE_URL`, and `TEST_WORKER_DATABASE_URL`.',
    'The integration suite requires `TEST_ADMIN_DATABASE_URL`, `TEST_MIGRATOR_DATABASE_URL`, `TEST_WORKER_DATABASE_URL`, and `TEST_TELEGRAM_DATABASE_URL`.',
)
replace_once(
    readme,
    '''The service uses the official Telegram Bot API directly with `getUpdates` long polling.
An existing webhook is a startup error and is never silently deleted. Only `message` and
`callback_query` updates are requested. The durable checkpoint stores the next update ID;
Telegram confirms every lower update when that offset is used on the next poll. A
PostgreSQL session advisory lock permits only one active long-poll consumer.''',
    '''The service uses the official Telegram Bot API directly with `getUpdates` long polling.
An existing webhook is a startup error and is never silently deleted. Only `message` and
`callback_query` updates are requested. Failed polls use bounded exponential backoff from
1 second, doubling to a 30-second exponential ceiling with up to 20% positive jitter;
Telegram `parameters.retry_after` is honored and the final delay is capped at 5 minutes.
Any successful Bot API poll, including an empty result, resets the failure counter, and
shutdown interrupts a pending backoff. Repeated failures are transition/rate-limited in
logs without request URLs, tokens, response bodies, or message data. The durable checkpoint
stores the next update ID; Telegram confirms every lower update when that offset is used on
the next poll. A PostgreSQL session advisory lock permits only one active long-poll
consumer.''',
)
replace_once(
    readme,
    '''digest. The digest also includes a short new-service-day status. DST behavior is covered by
CI. No minimum coverage threshold suppresses delivery.''',
    '''digest. The digest also includes a short new-service-day status plus one compact technical
section: available safe host/process CPU, host/container/process memory, disk free ratio,
database size, spool size/pending state, and open ingestion/bot-monitor incidents.
Unavailable measurements are labelled `unavailable`, never rendered as zero. DST behavior
is covered by CI. No minimum coverage threshold suppresses delivery.''',
)
replace_once(
    readme,
    '''Ingestion owns incident facts; `telegram-ops` owns Telegram delivery. ACTIVE and RECOVERY
markers are durable and retried with bounded backoff, so a successful Telegram delivery is
not retried because another transport failed. The worker is not given Telegram credentials.
Starting defaults include: durable ingestion stale for 2 minutes; matching below 2% for
three evaluations and recovery above 5% for three; malformed-rate breach for three cycles;
spool backlog for 5 minutes or any shedding; PostgreSQL unavailable for three bot checks;
CPU above 90% for 15 minutes; memory above 85% for 10 minutes; disk below 15% warning and
below 8% critical; static GTFS older than 8 days; and unresolved previous-day finalization
at 06:30. Noncritical persistent monitor episodes appear in `/status`/daily output.''',
    '''Ingestion owns incident facts; `telegram-ops` owns Telegram delivery. The worker continues
to detect and persist `ingest.stale`, matching-collapse, malformed-spike, and other
incident facts. To prevent duplicate Telegram notifications, the independent Telegram
watchdog is the sole Telegram notifier for the `ingest.stale` problem class while still
checking durable-ingestion freshness when the worker itself has stopped; the worker-owned
`ingest.stale` row remains read-only context. Matching/malformed thresholds are controlled
only by the existing `INGEST_MATCHING_RATE_MINIMUM`,
`INGEST_MATCHING_RATE_RECOVERY_MINIMUM`, `INGEST_MATCHING_RECOVERY_THRESHOLD`,
`INGEST_ALERT_FAILURE_THRESHOLD`, and `INGEST_MALFORMED_RATE_MAXIMUM` settings. There are
no duplicate `TELEGRAM_ALERT_MATCHING_*` or `TELEGRAM_ALERT_MALFORMED_*` settings.
Telegram-specific defaults remain: ingestion freshness from `INGEST_STALE_AFTER_MS`
(2 minutes), spool backlog 5 minutes, PostgreSQL unavailable after three bot checks, CPU
above 90% for 15 minutes, memory above 85% for 10 minutes, disk below 15% warning/below 8%
critical, static GTFS older than 8 days, and unresolved previous-day finalization at 06:30.
Normal incident/digest/command delivery markers are durable in PostgreSQL and retried with
bounded backoff.''',
)
replace_once(
    readme,
    '''`/resources` always distinguishes unavailable measurements from zero. Safe portable
measurements include the Telegram process/container, PostgreSQL/table/index growth, spool
size and mounted-volume free space. Metrics for another container are explicitly unavailable
without privileged access. Optional Pi host metrics use only configured read-only `/proc`
and root-filesystem mounts; the image works with that mode disabled.''',
    '''`/resources` always distinguishes unavailable measurements from zero. Safe portable
measurements include the Telegram process/container, PostgreSQL size, spool size and
mounted-volume free space. Metrics for another container are explicitly unavailable without
privileged access. Optional Pi host metrics use only configured read-only `/proc` and
root-filesystem mounts; the image works with that mode disabled. The service stores at most
one numeric resource/storage sample per hour and prunes samples older than 30 days; it never
stores rendered reports, Telegram content, chart bytes, or Bot API responses. `/pilot`
separates current total database size from measured growth and projected variable growth.
A 14-day projection requires at least two usable database-size samples at least six hours
apart and spanning distinct Europe/Madrid service dates; otherwise it says `projection
unavailable`. The projection extrapolates only observed database-size change and explicitly
does not claim future static-feed or index changes.''',
)
replace_once(
    readme,
    '''Chart contracts are implemented as bounded data specifications and complete text fallback.''',
    '''A PostgreSQL outage is the unavoidable durability exception: while PostgreSQL is down,
`telegram-ops` keeps long polling and independent monitoring alive where possible and a
queued command receives one bounded `Reporting database unavailable` response per process.
The PostgreSQL ACTIVE/RECOVERY sent marker and this per-update fallback are bounded
process-local state because their durable ledger is itself unavailable. Therefore exactly-
once Telegram delivery is **not** claimed across a `telegram-ops` restart that occurs during
the database outage. After PostgreSQL recovers, normal durable command handling resumes.

A deliberately real one-shot Telegram delivery test is available without starting polling,
changing command menus, querying PostgreSQL, or touching incident state:

```sh
docker compose --env-file .env run --rm --no-deps telegram-ops \
  test-notification --confirm-send
```

The command refuses to send without the literal confirmation flag, validates the bot token
and exact configured user/private-chat IDs, sends one clearly labelled Atodotren test
message, suppresses credential/response details on failure, and exits nonzero if delivery
fails. Ordinary CI uses only fake Telegram.

The container healthcheck has no public HTTP port. When Telegram operations are enabled it
tracks the timestamp of successful long-poll/service progress in a mode-0600 local health
file containing only a timestamp. Health is stale after the configured long-poll timeout
plus 30 seconds of grace. When `TELEGRAM_OPERATIONS_ENABLED=false`, health is deliberately
reported healthy so disabling the optional service does not create a restart loop.

Chart contracts are implemented as bounded data specifications and complete text fallback.''',
)

replace_once(
    plan,
    '''Group roles are project-prefixed, `NOLOGIN`, and must have no superuser, role creation, database creation, replication, or row-security-bypass attributes. The migration login receives non-inherited, set-only membership in `atodotren_migration_admin`; the migration runner assumes that owner role for every migration transaction so rotating the login cannot change object ownership or default privileges.''',
    '''Group roles are project-prefixed, `NOLOGIN`, and must have no superuser, role creation, database creation, replication, or row-security-bypass attributes. The migration login receives non-inherited, set-only membership in `atodotren_migration_admin`; the migration runner assumes that owner role for every migration transaction so rotating the login cannot change object ownership or default privileges. Milestone 5 upgrades retained Milestone 4 volumes by running the same idempotent role-bootstrap contract explicitly before migration 0009; PostgreSQL init scripts are not assumed to rerun for an existing volume, existing login passwords are never silently rotated, and the post-upgrade preflight verifies the exact `atodotren_telegram` reporting membership.''',
)
old_m5 = '''### Milestone 5 — Two-week evidence pilot

Milestone 5 is explicitly split into three phases:

1. CI-only implementation/readiness: provider-neutral reports, the private read-only Telegram operations container, migration/role security, fake-transport tests, Compose smoke and multiarchitecture builds. No project runtime is executed outside GitHub Actions in this phase.
2. Manual Pi/local deployment and pilot launch: configure BotFather/token and private IDs, apply migration 0009, validate read-only host metrics if desired, exercise real Telegram delivery deliberately, and start the two-week evidence pilot.
3. Pilot analysis/corrections: inspect Renfe behavior, matching/evidence quality, outages, storage/WAL/spool growth, replay reproducibility, query performance and sizing before accepting thresholds or cost projections.

CI-only accepted scope includes `worker report` plus `/status`, `/daily`, `/line`, `/station`, `/trains`, `/train`, `/incidents`, `/resources`, `/pilot`, and `/help`. Telegram is private, English operational text only, exact user+private-chat authorization, `getUpdates` long polling under one advisory-lock owner, read-only reporting, bounded queries/results, durable checkpoints/delivery markers and no arbitrary SQL or mutating administration. Ingestion persists incident facts; the Telegram service is the sole Telegram sender. Daily scheduling is Europe/Madrid 04:00 readiness, 05:00 normal target, and one provisional/blocked digest at 06:30 if finalization remains unresolved. The agreed punctuality threshold remains 120 seconds.

Resource reporting is portable and never fabricates zero for unavailable data. Optional Pi host metrics use narrowly scoped read-only mounts and no Docker socket/privileged mode. PNG chart rendering is deferred from the CI-only phase unless it can be implemented without an unverified dependency; bounded chart specifications and text fallback are required meanwhile.

Exit from phase 1: all required GitHub Actions gates are green and the branch is documented as ready for local/Pi verification. This does not accept Milestone 5. Final Milestone 5 exit remains approval or adjustment of thresholds, histogram range, indexes, provider sizing, and projected annual cost using the completed pilot evidence.'''
new_m5 = '''### Milestone 5 — Two-week evidence pilot

Milestone 5 is explicitly split into three phases:

1. CI-only implementation/readiness: provider-neutral reports, the private read-only Telegram operations container, migration/role security, retained-volume upgrade coverage, fake-transport tests, Compose smoke and multiarchitecture builds. No project runtime is executed outside GitHub Actions in this phase.
2. Manual Pi/local deployment and pilot launch: back up the retained volume, run the explicit idempotent role bootstrap before migration 0009, configure BotFather/token and exact private IDs, run preflight, validate optional read-only host metrics, exercise the confirmed one-shot real Telegram test, and start the two-week evidence pilot.
3. Pilot analysis/corrections: inspect Renfe behavior, matching/evidence quality, outages, measured database/spool/resource growth, replay reproducibility, query performance and sizing before accepting thresholds or cost projections.

CI-only scope includes `worker report` plus `/status`, `/daily`, `/line`, `/station`, `/trains`, `/train`, `/incidents`, `/resources`, `/pilot`, and `/help`. Telegram is private, English operational text only, exact user+private-chat authorization, `getUpdates` long polling under one advisory-lock owner, read-only reporting, bounded queries/results, durable checkpoints/delivery markers and no arbitrary SQL or mutating administration. Poll failures use bounded exponential backoff with jitter and official Bot API `retry_after` handling; successful empty polls reset the backoff and shutdown interrupts it.

Ingestion persists incident facts and remains the detector for matching/malformed conditions using the existing `INGEST_*` settings. Telegram delivery belongs only to `telegram-ops`; its independent freshness watchdog is the sole Telegram notifier for `ingest.stale`, preventing duplicate worker/watchdog ACTIVE/RECOVERY delivery while still detecting a stopped worker. Normal delivery markers are PostgreSQL-durable. PostgreSQL-outage ACTIVE/RECOVERY and command-unavailable fallback state are necessarily bounded and process-local while the database itself is unavailable, so exactly-once delivery is not claimed across a bot restart during that outage.

Daily scheduling is Europe/Madrid 04:00 readiness, 05:00 normal target, and one provisional/blocked digest at 06:30 if finalization remains unresolved. The digest includes compact CPU, memory, disk, database, spool/pending, and open-incident information with explicit unavailable states. The agreed punctuality threshold remains 120 seconds.

Resource reporting is portable and never fabricates zero for unavailable data. Optional Pi host metrics use narrowly scoped read-only mounts and no Docker socket/privileged mode. Numeric resource/storage samples are at most hourly and retained for at most 30 days. Storage projection uses measured database-size change between useful samples on distinct service dates; with insufficient evidence it is unavailable, and it never claims future static-feed/index changes. The no-port healthcheck tracks successful service-loop progress and accounts for the configured long-poll timeout. PNG chart rendering remains deferred; bounded chart specifications and text fallback are required meanwhile.

Exit from phase 1: all required GitHub Actions gates are green and the branch is documented as ready for local/Pi verification. This does not accept Milestone 5. Final Milestone 5 exit remains approval or adjustment of thresholds, histogram range, indexes, provider sizing, and projected annual cost using the completed pilot evidence.'''
replace_once(plan, old_m5, new_m5)
replace_once(
    plan,
    '1. Begin the Milestone 5 evidence pilot using the accepted Milestone 4 statistics and retention foundation.',
    '1. Complete the Milestone 5 local/Pi validation checklist and only then launch the two-week evidence pilot; CI readiness alone does not accept the milestone.',
)

begin = '  # BEGIN M5_CORRECTION_DOCS_JOB\n'
end = '  # END M5_CORRECTION_DOCS_JOB\n'
workflow_text = workflow.read_text(encoding='utf-8')
start = workflow_text.find(begin)
finish = workflow_text.find(end)
if start < 0 or finish < 0 or finish < start:
    raise RuntimeError('temporary correction-docs workflow markers are missing')
finish += len(end)
workflow.write_text(workflow_text[:start] + workflow_text[finish:], encoding='utf-8')

readme_text = readme.read_text(encoding='utf-8')
plan_text = plan.read_text(encoding='utf-8')
if len(readme_text) < 25_000 or 'Existing Milestone 4 PostgreSQL volume upgrade' not in readme_text:
    raise RuntimeError('README integrity check failed after correction documentation update')
if len(plan_text) < 20_000 or 'PostgreSQL-outage ACTIVE/RECOVERY' not in plan_text:
    raise RuntimeError('implementation-plan integrity check failed after correction documentation update')
for required in ['PNG rendering/sendPhoto is intentionally deferred', 'two-week evidence pilot']:
    if required not in readme_text:
        raise RuntimeError(f'README lost required deferred/acceptance statement: {required}')
