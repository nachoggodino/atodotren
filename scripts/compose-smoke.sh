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
compose wait worker >/dev/null

for service in migrate static-import worker; do
  service_id="$(compose ps --all --quiet "${service}")"
  exit_code="$(docker inspect --format '{{.State.ExitCode}}' "${service_id}")"
  if [[ "${exit_code}" != '0' ]]; then
    echo "Compose dependency-chain service ${service} exited with ${exit_code}" >&2
    exit 1
  fi
done

compose restart postgres
compose up --detach --wait postgres
compose run --rm --no-deps migrate
repeat_report="$(compose run --rm --no-deps static-import import-static --file /fixtures/representative-madrid.zip --json)"
if ! grep -q '"result":"unchanged"' <<<"${repeat_report}"; then
  echo "Repeated fixture import was not checksum-idempotent: ${repeat_report}" >&2
  exit 1
fi
compose run --rm --no-deps worker doctor

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

echo 'Compose smoke test passed: PostgreSQL -> migration -> Madrid fixture import -> doctor succeeded; restart and repeated checksum import were safe; zero fixture non-Madrid routes were retained.'
