#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${ATODOTREN_REAL_STATIC_SMOKE:-}" != '1' ]]; then
  echo 'Real RENFE static smoke test is disabled. Set ATODOTREN_REAL_STATIC_SMOKE=1 to make the single bounded external download.' >&2
  exit 2
fi
if ! command -v docker >/dev/null 2>&1; then
  echo 'Docker is required for the real static smoke test; no external request was made.' >&2
  exit 1
fi

container_name="atodotren-real-static-$$"
admin_password='local-real-static-admin-password'
worker_password='local-real-static-worker-password'
metrics_file="$(mktemp /tmp/atodotren-real-static-metrics.XXXXXX)"

cleanup() {
  docker rm --force "${container_name}" >/dev/null 2>&1 || true
  rm -f "${metrics_file}"
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

npm run db:migrate >/dev/null
set +e
report="$(/usr/bin/time --format='peak_node_rss_kb=%M elapsed_seconds=%e' --output="${metrics_file}" \
  npm run worker --silent -- import-static --json)"
import_exit=$?
set -e
if [[ ${import_exit} -ne 0 ]]; then
  echo "Real RENFE static smoke test failed its external acquisition/import dependency: ${report}" >&2
  exit 1
fi

non_madrid="$(docker exec "${container_name}" psql --username postgres --dbname atodotren --tuples-only --no-align --command "SELECT count(*) FROM gtfs_static.route AS route JOIN gtfs_static.feed_version AS version ON version.id = route.feed_version_id WHERE version.status = 'active' AND route.route_id NOT LIKE '10%'")"
if [[ "${non_madrid}" != '0' ]]; then
  echo "Real static smoke retained ${non_madrid} routes outside the explicit Madrid route-prefix mapping" >&2
  exit 1
fi

fact_audit="$(docker exec "${container_name}" psql --username postgres --dbname atodotren --tuples-only --no-align --command "
WITH active AS (SELECT id FROM gtfs_static.feed_version WHERE status = 'active')
SELECT json_build_object(
  'routes_outside_prefix', (SELECT count(*) FROM gtfs_static.route r, active a WHERE r.feed_version_id = a.id AND r.route_id NOT LIKE '10%'),
  'trips_outside_routes', (SELECT count(*) FROM gtfs_static.trip t, active a WHERE t.feed_version_id = a.id AND t.route_id NOT LIKE '10%'),
  'unreferenced_stops', (SELECT count(*) FROM gtfs_static.stop s, active a WHERE s.feed_version_id = a.id AND NOT EXISTS (SELECT 1 FROM gtfs_static.stop_time st WHERE st.feed_version_id = s.feed_version_id AND st.stop_id = s.stop_id)),
  'unreferenced_services', (SELECT count(*) FROM gtfs_static.calendar_service c, active a WHERE c.feed_version_id = a.id AND NOT EXISTS (SELECT 1 FROM gtfs_static.trip t WHERE t.feed_version_id = c.feed_version_id AND t.service_id = c.service_id)),
  'unreferenced_shapes', (SELECT count(*) FROM gtfs_static.shape s, active a WHERE s.feed_version_id = a.id AND NOT EXISTS (SELECT 1 FROM gtfs_static.trip t WHERE t.feed_version_id = s.feed_version_id AND t.shape_id = s.shape_id))
)")"
fact_errors="$(docker exec "${container_name}" psql --username postgres --dbname atodotren --tuples-only --no-align --command "
WITH active AS (SELECT id FROM gtfs_static.feed_version WHERE status = 'active')
SELECT
  (SELECT count(*) FROM gtfs_static.route r, active a WHERE r.feed_version_id = a.id AND r.route_id NOT LIKE '10%')
  + (SELECT count(*) FROM gtfs_static.trip t, active a WHERE t.feed_version_id = a.id AND t.route_id NOT LIKE '10%')
  + (SELECT count(*) FROM gtfs_static.stop s, active a WHERE s.feed_version_id = a.id AND NOT EXISTS (SELECT 1 FROM gtfs_static.stop_time st WHERE st.feed_version_id = s.feed_version_id AND st.stop_id = s.stop_id))
  + (SELECT count(*) FROM gtfs_static.calendar_service c, active a WHERE c.feed_version_id = a.id AND NOT EXISTS (SELECT 1 FROM gtfs_static.trip t WHERE t.feed_version_id = c.feed_version_id AND t.service_id = c.service_id))
  + (SELECT count(*) FROM gtfs_static.shape s, active a WHERE s.feed_version_id = a.id AND NOT EXISTS (SELECT 1 FROM gtfs_static.trip t WHERE t.feed_version_id = s.feed_version_id AND t.shape_id = s.shape_id))
")"
if [[ "${fact_errors}" != '0' ]]; then
  echo "Real static smoke found facts outside the retained Madrid dependency closure: ${fact_audit}" >&2
  exit 1
fi

station_audit="$(docker exec "${container_name}" psql --username postgres --dbname atodotren --tuples-only --no-align --command "
WITH active AS (SELECT id FROM gtfs_static.feed_version WHERE status = 'active')
SELECT json_build_object(
  'stops', count(*),
  'distinct_stop_ids', count(DISTINCT stop.stop_id),
  'nonempty_stop_codes', count(*) FILTER (WHERE NULLIF(btrim(stop.stop_code), '') IS NOT NULL),
  'parent_stations', count(*) FILTER (WHERE NULLIF(btrim(stop.parent_station), '') IS NOT NULL),
  'mapped_stations', count(DISTINCT mapping.station_id)
)
FROM active
JOIN gtfs_static.stop AS stop ON stop.feed_version_id = active.id
JOIN gtfs_static.stop_station_map AS mapping ON mapping.feed_version_id = stop.feed_version_id AND mapping.stop_id = stop.stop_id
")"

doctor_report="$(LOG_LEVEL=info npm run worker --silent -- doctor)"

printf '%s\n' "${report}"
printf 'real_static_metrics %s\n' "$(<"${metrics_file}")"
printf 'real_static_station_audit %s\n' "${station_audit}"
printf 'real_static_fact_audit %s\n' "${fact_audit}"
printf 'real_static_doctor %s\n' "${doctor_report}"
echo 'Real RENFE static smoke passed against disposable local PostgreSQL; the source was downloaded once and transient data was cleaned.'
