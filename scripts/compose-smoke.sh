#!/usr/bin/env bash
set -Eeuo pipefail

environment_file="${1:-example.env}"
project_name="atodotren-smoke-$$"

if ! command -v docker >/dev/null 2>&1; then
  echo 'Docker is required for the Compose smoke test; the test was not run.' >&2
  exit 1
fi
if [[ ! -f "${environment_file}" ]]; then
  echo "Environment file not found: ${environment_file}" >&2
  exit 1
fi

cleanup() {
  POSTGRES_PORT=0 docker compose --project-name "${project_name}" --env-file "${environment_file}" \
    --file compose.yaml --file compose.smoke.yaml down \
    --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

compose() {
  POSTGRES_PORT=0 docker compose --project-name "${project_name}" --env-file "${environment_file}" \
    --file compose.yaml --file compose.smoke.yaml "$@"
}

fake_telegram_count() {
  compose exec --no-TTY fake-telegram node -e "fetch('http://localhost:4020/state').then(r=>r.json()).then(s=>console.log(s.sentMessages.length))"
}

compose build worker migrate static-import telegram-ops
compose up --detach worker
for service in role-bootstrap migrate static-import; do
  service_id="$(compose ps --all --quiet "${service}")"
  exit_code="$(docker inspect --format '{{.State.ExitCode}}' "${service_id}")"
  if [[ "${exit_code}" != '0' ]]; then
    echo "Compose dependency-chain service ${service} exited with ${exit_code}" >&2
    exit 1
  fi
done

poll_count='0'
for _attempt in {1..30}; do
  poll_count="$(compose exec --no-TTY postgres sh -c 'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align --command "SELECT count(*) FROM ingest.poll_run WHERE result_class = '\''success'\''"')"
  if [[ "${poll_count}" -ge 6 ]]; then break; fi
  sleep 1
done
if [[ "${poll_count}" -lt 6 ]]; then
  compose logs worker fake-feed >&2
  echo "Deterministic realtime ingestion did not produce enough successful polls: ${poll_count}" >&2
  exit 1
fi

compose stop postgres >/dev/null
spool_pending='0'
for _attempt in {1..30}; do
  spool_pending="$(compose exec --no-TTY worker node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('/spool/realtime.sqlite', { readOnly: true }); console.log(db.prepare('SELECT count(*) AS n FROM pending_operation').get().n);")"
  if [[ "${spool_pending}" -gt 0 ]]; then break; fi
  sleep 1
done
if [[ "${spool_pending}" -le 0 ]]; then
  compose logs worker >&2
  echo 'Worker did not queue normalized operations while PostgreSQL was stopped.' >&2
  exit 1
fi

compose start postgres >/dev/null
compose up --detach --wait postgres >/dev/null
for _attempt in {1..30}; do
  spool_pending="$(compose exec --no-TTY worker node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('/spool/realtime.sqlite', { readOnly: true }); console.log(db.prepare('SELECT count(*) AS n FROM pending_operation').get().n);")"
  if [[ "${spool_pending}" == '0' ]]; then break; fi
  sleep 1
done
if [[ "${spool_pending}" != '0' ]]; then
  compose logs worker >&2
  echo "SQLite spool did not replay after PostgreSQL recovery: ${spool_pending} pending" >&2
  exit 1
fi

compose restart worker >/dev/null
sleep 2
if [[ "$(compose ps --status running --quiet worker | wc -l | tr -d ' ')" != '1' ]]; then
  compose logs worker >&2
  echo 'Continuous worker did not restart successfully.' >&2
  exit 1
fi

compose run --rm --no-deps role-bootstrap
compose run --rm --no-deps migrate
repeat_report="$(compose run --rm --no-deps static-import import-static --file /fixtures/representative-madrid.zip --json)"
if ! grep -q '"result":"unchanged"' <<<"${repeat_report}"; then
  echo "Repeated fixture import was not checksum-idempotent: ${repeat_report}" >&2
  exit 1
fi
compose run --rm --no-deps worker doctor
compose run --rm --no-deps worker aggregate --limit 1
compose run --rm --no-deps worker finalize --limit 1 --retention

realtime_state="$(compose exec --no-TTY postgres sh -c 'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align --field-separator=, --command "SELECT (SELECT count(*) FROM ingest.stop_evidence WHERE evidence_classification = '\''reported_prediction'\''), (SELECT count(*) FROM ingest.stop_evidence WHERE evidence_classification = '\''observed_presence'\''), (SELECT count(*) FROM ingest.service_alert), (SELECT count(*) FROM ingest.live_vehicle_state)"')"
IFS=',' read -r prediction_count presence_count alert_count vehicle_count <<<"${realtime_state}"
if [[ "${prediction_count}" != '2' || "${presence_count}" != '1' || "${alert_count}" != '1' || "${vehicle_count}" != '1' ]]; then
  echo "Unexpected realtime deduplication state: ${realtime_state}" >&2
  exit 1
fi

compose exec --no-TTY worker node --input-type=module -e "import { gunzipSync } from 'node:zlib'; import pg from 'pg'; const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }); const result = await pool.query('SELECT compressed_payload FROM ingest.filtered_payload'); for (const row of result.rows) { const text = gunzipSync(row.compressed_payload).toString('utf8'); if (text.includes('20TRIP-A') || text.includes('national-trip-update')) process.exitCode = 1; } await pool.end();"

madrid_only="$(compose exec --no-TTY postgres sh -c 'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align --command "SELECT count(*) FROM gtfs_static.route AS route JOIN gtfs_static.feed_version AS version ON version.id = route.feed_version_id WHERE version.status = '\''active'\'' AND route.route_id LIKE '\''20%'\''"')"
if [[ "${madrid_only}" != '0' ]]; then
  echo "Compose fixture retained non-Madrid routes: ${madrid_only}" >&2
  exit 1
fi

compose up --detach --wait fake-telegram telegram-ops
for _attempt in {1..30}; do
  if [[ "$(fake_telegram_count)" -ge 1 ]]; then break; fi
  sleep 1
done
telegram_state="$(compose exec --no-TTY fake-telegram node -e "fetch('http://localhost:4020/state').then(r=>r.json()).then(s=>console.log(JSON.stringify(s)))")"
if ! grep -q 'Status ' <<<"${telegram_state}"; then
  compose logs telegram-ops fake-telegram >&2
  echo "Fake Telegram command did not round-trip: ${telegram_state}" >&2
  exit 1
fi

before_test="$(fake_telegram_count)"
compose run --rm --no-deps telegram-ops test-notification --confirm-send >/dev/null
after_test="$(fake_telegram_count)"
if [[ "${after_test}" -ne $((before_test + 1)) ]]; then
  compose logs telegram-ops fake-telegram >&2
  echo "One-shot Telegram test did not send exactly one fake message: before=${before_test}, after=${after_test}" >&2
  exit 1
fi

before_restart="$(fake_telegram_count)"
compose restart telegram-ops >/dev/null
sleep 3
after_restart="$(fake_telegram_count)"
if [[ "${after_restart}" != "${before_restart}" ]]; then
  compose logs telegram-ops fake-telegram >&2
  echo "Telegram restart duplicated a delivered command/digest: before=${before_restart}, after=${after_restart}" >&2
  exit 1
fi

compose exec --no-TTY postgres sh -c 'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 --command "INSERT INTO operations.notification_incident (incident_key, opened_at, last_observed_at, occurrence_count, is_open, details) VALUES ('\''spool.shedding'\'', clock_timestamp(), clock_timestamp(), 1, true, '\''{}'\''::jsonb) ON CONFLICT (incident_key) DO UPDATE SET opened_at=EXCLUDED.opened_at,last_observed_at=EXCLUDED.last_observed_at,occurrence_count=1,is_open=true,recovered_at=NULL"' >/dev/null
incident_baseline="$(fake_telegram_count)"
for _attempt in {1..75}; do
  current="$(fake_telegram_count)"
  if [[ "${current}" -gt "${incident_baseline}" ]]; then break; fi
  sleep 1
done
active_count="$(compose exec --no-TTY postgres sh -c 'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align --command "SELECT count(*) FROM operations.telegram_delivery WHERE delivery_type='\''incident_active'\'' AND delivered_at IS NOT NULL"')"
if [[ "${active_count}" != '1' ]]; then
  compose logs telegram-ops >&2
  echo "Expected exactly one Telegram ACTIVE incident delivery, got ${active_count}" >&2
  exit 1
fi

compose exec --no-TTY postgres sh -c 'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 --command "UPDATE operations.notification_incident SET is_open=false,recovered_at=clock_timestamp(),last_observed_at=clock_timestamp() WHERE incident_key='\''spool.shedding'\''"' >/dev/null
for _attempt in {1..75}; do
  recovery_count="$(compose exec --no-TTY postgres sh -c 'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align --command "SELECT count(*) FROM operations.telegram_delivery WHERE delivery_type='\''incident_recovery'\'' AND delivered_at IS NOT NULL"')"
  if [[ "${recovery_count}" == '1' ]]; then break; fi
  sleep 1
done
if [[ "${recovery_count:-0}" != '1' ]]; then
  compose logs telegram-ops >&2
  echo "Expected exactly one Telegram RECOVERY delivery, got ${recovery_count:-0}" >&2
  exit 1
fi

container_id="$(compose ps --quiet postgres)"
health="$(docker inspect --format '{{.State.Health.Status}}' "${container_id}")"
telegram_container_id="$(compose ps --quiet telegram-ops)"
telegram_health="$(docker inspect --format '{{.State.Health.Status}}' "${telegram_container_id}")"
if [[ "${health}" != 'healthy' || "${telegram_health}" != 'healthy' ]]; then
  echo "Unexpected container health: postgres=${health}, telegram=${telegram_health}" >&2
  exit 1
fi

echo 'Compose smoke passed: startup ordering with idempotent role bootstrap, fake feeds, spool interruption/replay, worker restart, migration/import idempotency, bounded aggregate commands, fake Telegram command round-trip and one-shot test, Telegram restart idempotency, meaningful Telegram freshness health, and sole Telegram ACTIVE/RECOVERY incident delivery.'
