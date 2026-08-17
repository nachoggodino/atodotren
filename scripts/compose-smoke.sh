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

compose build worker migrate static-import
compose up --detach worker
for service in migrate static-import; do
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
  if [[ "${poll_count}" -ge 6 ]]; then
    break
  fi
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
  if [[ "${spool_pending}" -gt 0 ]]; then
    break
  fi
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
  if [[ "${spool_pending}" == '0' ]]; then
    break
  fi
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

compose run --rm --no-deps migrate
repeat_report="$(compose run --rm --no-deps static-import import-static --file /fixtures/representative-madrid.zip --json)"
if ! grep -q '"result":"unchanged"' <<<"${repeat_report}"; then
  echo "Repeated fixture import was not checksum-idempotent: ${repeat_report}" >&2
  exit 1
fi
compose run --rm --no-deps worker doctor

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

container_id="$(compose ps --quiet postgres)"
health="$(docker inspect --format '{{.State.Health.Status}}' "${container_id}")"
if [[ "${health}" != 'healthy' ]]; then
  echo "PostgreSQL container is not healthy: ${health}" >&2
  exit 1
fi

echo 'Compose smoke test passed: startup ordering, deterministic protobuf polling, worker restart, PostgreSQL interruption, bounded SQLite queuing, ordered recovery, duplicate-safe evidence, Madrid-only filtered payloads, and doctor health all succeeded.'
