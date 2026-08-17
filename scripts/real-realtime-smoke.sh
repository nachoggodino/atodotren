#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${ATODOTREN_REAL_REALTIME_SMOKE:-}" != '1' ]]; then
  echo 'Real RENFE realtime smoke is disabled. Set ATODOTREN_REAL_REALTIME_SMOKE=1 for the bounded external run.' >&2
  exit 2
fi
if ! command -v docker >/dev/null 2>&1; then
  echo 'Docker is required; no external RENFE request was made.' >&2
  exit 1
fi

cycles="${ATODOTREN_REAL_REALTIME_CYCLES:-2}"
if ! [[ "${cycles}" =~ ^[1-9][0-9]*$ ]] || [[ "${cycles}" -gt 5 ]]; then
  echo 'ATODOTREN_REAL_REALTIME_CYCLES must be an integer from 1 through 5.' >&2
  exit 2
fi

container_name="atodotren-real-realtime-$$"
admin_password='local-real-realtime-admin-password'
worker_password='local-real-realtime-worker-password'
spool_directory="$(mktemp -d /tmp/atodotren-real-realtime-spool.XXXXXX)"

cleanup() {
  docker rm --force "${container_name}" >/dev/null 2>&1 || true
  rm -rf "${spool_directory}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker run --detach --name "${container_name}" \
  --env POSTGRES_DB=atodotren \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD="${admin_password}" \
  --env ATODOTREN_WORKER_PASSWORD="${worker_password}" \
  --publish 127.0.0.1::5432 \
  --health-cmd 'pg_isready -U postgres -d atodotren' \
  --health-interval 1s --health-timeout 5s --health-retries 30 \
  --volume "${PWD}/docker/postgres/init/001-runtime-roles.sh:/docker-entrypoint-initdb.d/001-runtime-roles.sh:ro" \
  postgres:18.4-bookworm >/dev/null

health='starting'
for _attempt in {1..60}; do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${container_name}")"
  [[ "${health}" == 'healthy' ]] && break
  if [[ "${health}" == 'unhealthy' ]]; then
    docker logs "${container_name}" >&2
    exit 1
  fi
  sleep 1
done
if [[ "${health}" != 'healthy' ]]; then
  echo "Disposable PostgreSQL did not become healthy: ${health}" >&2
  exit 1
fi

host_port="$(docker port "${container_name}" 5432/tcp | sed -E 's/.*:([0-9]+)$/\1/')"
export DATABASE_URL="postgresql://atodotren_worker:${worker_password}@localhost:${host_port}/atodotren"
export MIGRATION_DATABASE_URL="postgresql://atodotren_migrator:${admin_password}@localhost:${host_port}/atodotren"
export DATABASE_SSL_MODE=disable
export NODE_ENV=test
export LOG_LEVEL=error
export SQLITE_SPOOL_PATH="${spool_directory}/realtime.sqlite"
export GTFS_RT_CYCLE_INTERVAL_MS=1000
export GTFS_RT_ALERT_INTERVAL_MS=1000
export GTFS_RT_REQUEST_TIMEOUT_MS=10000

npm run db:migrate >/dev/null
static_report="$(npm run worker --silent -- import-static --json)"

set +e
ingest_report="$(npm run worker --silent -- ingest --cycles "${cycles}" 2>&1)"
ingest_exit=$?
set -e
if [[ ${ingest_exit} -ne 0 ]]; then
  if grep -Eq 'http_4xx|http_5xx|network_error|timeout' <<<"${ingest_report}"; then
    echo "Real RENFE realtime endpoint was externally unavailable during the bounded run: ${ingest_report}" >&2
  else
    echo "Real RENFE realtime implementation smoke failed: ${ingest_report}" >&2
  fi
  exit 1
fi

database_report="$(docker exec "${container_name}" psql --username postgres --dbname atodotren --tuples-only --no-align --command "
SELECT json_build_object(
  'polls', (SELECT count(*) FROM ingest.poll_run),
  'successful_polls', (SELECT count(*) FROM ingest.poll_run WHERE result_class = 'success'),
  'feeds', (SELECT json_object_agg(feed_kind, metrics) FROM (
    SELECT feed_kind, json_build_object(
      'polls', count(*),
      'response_bytes', sum(response_bytes),
      'response_duration_ms', sum(response_duration_ms),
      'matched_madrid', sum(matched_madrid_count),
      'non_madrid', sum(non_madrid_count),
      'unmatched', sum(unmatched_count),
      'invalid', sum(invalid_count)
    ) AS metrics
    FROM ingest.poll_run GROUP BY feed_kind
  ) AS per_feed),
  'response_bytes', (SELECT COALESCE(sum(response_bytes), 0) FROM ingest.poll_run),
  'matched_madrid', (SELECT COALESCE(sum(matched_madrid_count), 0) FROM ingest.poll_run),
  'non_madrid', (SELECT COALESCE(sum(non_madrid_count), 0) FROM ingest.poll_run),
  'unmatched', (SELECT COALESCE(sum(unmatched_count), 0) FROM ingest.poll_run),
  'invalid', (SELECT COALESCE(sum(invalid_count), 0) FROM ingest.poll_run),
  'evidence', (SELECT count(*) FROM ingest.stop_evidence),
  'vehicles', (SELECT count(*) FROM ingest.live_vehicle_state),
  'alerts', (SELECT count(*) FROM ingest.service_alert),
  'quarantine', (SELECT count(*) FROM ingest.quarantined_entity),
  'filtered_payload_bytes', (SELECT COALESCE(sum(octet_length(compressed_payload)), 0) FROM ingest.filtered_payload),
  'spool_pending', (SELECT spool_pending_count FROM operations.ingest_health WHERE singleton)
)")"

national_payload_count="$(node --input-type=module -e "import { gunzipSync } from 'node:zlib'; import pg from 'pg'; const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }); const result = await pool.query('SELECT compressed_payload FROM ingest.filtered_payload'); let national = 0; for (const row of result.rows) { const parsed = JSON.parse(gunzipSync(row.compressed_payload).toString('utf8')); national += parsed.entities.filter((entity) => entity.trip?.routeId && !entity.trip.routeId.startsWith('10')).length; } console.log(national); await pool.end();")"
if [[ "${national_payload_count}" != '0' ]]; then
  echo "Madrid-filtered payload storage retained ${national_payload_count} clear national entities." >&2
  exit 1
fi

replay_report="$(npm run worker --silent -- replay)"
doctor_report="$(LOG_LEVEL=info npm run worker --silent -- doctor)"

printf 'real_realtime_static %s\n' "${static_report}"
printf 'real_realtime_ingest %s\n' "${ingest_report}"
printf 'real_realtime_database %s\n' "${database_report}"
printf 'real_realtime_replay %s\n' "${replay_report}"
printf 'real_realtime_doctor %s\n' "${doctor_report}"
echo 'Real RENFE realtime smoke passed with disposable PostgreSQL and spool; no national protobuf response was retained.'
