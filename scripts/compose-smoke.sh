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
  POSTGRES_PORT=0 docker compose --project-name "${project_name}" --env-file "${environment_file}" down \
    --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

compose() {
  POSTGRES_PORT=0 docker compose --project-name "${project_name}" --env-file "${environment_file}" "$@"
}

compose build worker migrate
compose up --detach worker
compose wait worker >/dev/null

for service in migrate worker; do
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
compose run --rm --no-deps worker doctor

container_id="$(compose ps --quiet postgres)"
health="$(docker inspect --format '{{.State.Health.Status}}' "${container_id}")"
if [[ "${health}" != 'healthy' ]]; then
  echo "PostgreSQL container is not healthy: ${health}" >&2
  exit 1
fi

echo 'Compose smoke test passed: the declared PostgreSQL -> migrate -> worker chain succeeded, migration remained idempotent, restart survived, and worker doctor succeeded twice.'
