#!/usr/bin/env bash
set -Eeuo pipefail

postgres_image="${1:?usage: postgres-contract.sh <exact-postgres-image>}"
container_name="atodotren-postgres-contract-$$"
admin_password='local-contract-admin-password'
worker_password='local-contract-worker-password'
telegram_password='local-contract-telegram-password'
web_password='local-contract-web-password'

if ! command -v docker >/dev/null 2>&1; then
  echo 'Docker is required for the PostgreSQL contract test; the test was not run.' >&2
  exit 1
fi

cleanup() {
  docker rm --force "${container_name}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --detach --name "${container_name}" \
  --env POSTGRES_DB=atodotren \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD="${admin_password}" \
  --env ATODOTREN_WORKER_PASSWORD="${worker_password}" \
  --env ATODOTREN_TELEGRAM_PASSWORD="${telegram_password}" \
  --env ATODOTREN_WEB_PASSWORD="${web_password}" \
  --publish 127.0.0.1::5432 \
  --health-cmd 'pg_isready -U postgres -d atodotren' \
  --health-interval 1s \
  --health-timeout 5s \
  --health-retries 30 \
  --volume "${PWD}/docker/postgres/init/001-runtime-roles.sh:/docker-entrypoint-initdb.d/001-runtime-roles.sh:ro" \
  "${postgres_image}" >/dev/null

for _attempt in {1..60}; do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${container_name}")"
  if [[ "${health}" == 'healthy' ]]; then break; fi
  if [[ "${health}" == 'unhealthy' ]]; then
    docker logs "${container_name}" >&2
    exit 1
  fi
  sleep 1
done

if [[ "${health}" != 'healthy' ]]; then
  docker logs "${container_name}" >&2
  echo "PostgreSQL contract container did not become healthy: ${health}" >&2
  exit 1
fi

host_port="$(docker port "${container_name}" 5432/tcp | sed -E 's/.*:([0-9]+)$/\1/')"
export TEST_ADMIN_DATABASE_URL="postgresql://postgres:${admin_password}@localhost:${host_port}/atodotren"
export TEST_MIGRATOR_DATABASE_URL="postgresql://atodotren_migrator:${admin_password}@localhost:${host_port}/atodotren"
export TEST_WORKER_DATABASE_URL="postgresql://atodotren_worker:${worker_password}@localhost:${host_port}/atodotren"
export TEST_TELEGRAM_DATABASE_URL="postgresql://atodotren_telegram:${telegram_password}@localhost:${host_port}/atodotren"
export TEST_WEB_DATABASE_URL="postgresql://atodotren_web:${web_password}@localhost:${host_port}/atodotren"
export POSTGRES_CONTRACT_CONTAINER_NAME="${container_name}"
export POSTGRES_CONTRACT_ADMIN_PASSWORD="${admin_password}"
export POSTGRES_CONTRACT_WORKER_PASSWORD="${worker_password}"
export POSTGRES_CONTRACT_TELEGRAM_PASSWORD="${telegram_password}"
export POSTGRES_CONTRACT_WEB_PASSWORD="${web_password}"

npm run test:integration
node scripts/web-postgres-contract.mjs
echo "PostgreSQL contract passed for ${postgres_image}."
