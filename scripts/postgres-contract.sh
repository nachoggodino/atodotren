#!/usr/bin/env bash
set -Eeuo pipefail

postgres_image="${1:?usage: postgres-contract.sh <exact-postgres-image> [full|compat]}"
contract_mode="${2:-full}"
if [[ "${contract_mode}" != 'full' && "${contract_mode}" != 'compat' ]]; then
  echo "Unknown PostgreSQL contract mode: ${contract_mode}" >&2
  exit 2
fi

container_name="atodotren-postgres-contract-$$"
admin_password='local-contract-admin-password'
worker_password='local-contract-worker-password'
telegram_password='local-contract-telegram-password'
web_password='local-contract-web-password'
legacy_root=''
legacy_worktree=''
web_migrations=(
  migrations/0013_public_web_api.sql
  migrations/0014_web_reader_permissions.sql
  migrations/0015_web_live_contract.sql
  migrations/0016_web_search_normalization.sql
  migrations/0017_landing_live_metrics.sql
  migrations/0018_web_live_freshness.sql
  migrations/0019_web_history_insights.sql
)

if ! command -v docker >/dev/null 2>&1; then
  echo 'Docker is required for the PostgreSQL contract test; the test was not run.' >&2
  exit 1
fi

cleanup() {
  if [[ -n "${legacy_worktree}" && -d "${legacy_worktree}" ]]; then
    git worktree remove --force "${legacy_worktree}" >/dev/null 2>&1 || true
    git worktree prune >/dev/null 2>&1 || true
  fi
  if [[ -n "${legacy_root}" ]]; then rm -rf "${legacy_root}"; fi
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

health='starting'
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

if [[ "${contract_mode}" == 'compat' ]]; then
  # The focused compatibility contract imports the migration implementation
  # directly, so compile only the database package instead of the entire test suite.
  npm run build --workspace @atodotren/db
  node scripts/postgres-compat-contract.mjs
  echo "PostgreSQL compatibility contract passed for ${postgres_image}."
  exit 0
fi

# The accepted worker/database suite intentionally exercises the historical
# 0001-0012 inventory. Run that inventory in an isolated worktree rather than
# moving migrations out of the active checkout.
legacy_root="$(mktemp -d)"
legacy_worktree="${legacy_root}/repo"
git worktree add --detach "${legacy_worktree}" HEAD >/dev/null
for migration in "${web_migrations[@]}"; do
  rm "${legacy_worktree}/${migration}"
done
cp -al node_modules "${legacy_worktree}/node_modules"
(
  cd "${legacy_worktree}"
  legacy_partition_watcher_pid=''

  # A frozen legacy fixture chooses the next weekday from current_date. On a
  # Friday that is Monday (+3), while immutable migration 0004 deliberately
  # pre-creates only current_date +/- 2. Keep production policy unchanged and
  # prepare the one additional permitted fixture partition in disposable test
  # databases as soon as each historical migration has created the helper.
  if [[ "$(date -u +%u)" == '5' ]]; then
    (
      while true; do
        databases="$(docker exec \
          --env PGPASSWORD="${admin_password}" \
          "${container_name}" psql -h 127.0.0.1 -U postgres -d postgres -Atqc \
          "SELECT datname FROM pg_database WHERE datname LIKE 'atodotren_%' AND datallowconn" 2>/dev/null || true)"
        while IFS= read -r database; do
          [[ -z "${database}" ]] && continue
          docker exec \
            --env PGPASSWORD="${admin_password}" \
            "${container_name}" psql -h 127.0.0.1 -U postgres -d "${database}" -Atqc \
            "SELECT ingest.ensure_realtime_partitions(current_date + 3)" \
            >/dev/null 2>&1 || true
        done <<< "${databases}"
        sleep 0.2
      done
    ) &
    legacy_partition_watcher_pid=$!
  fi

  set +e
  npm run test:integration
  integration_status=$?
  set -e

  if [[ -n "${legacy_partition_watcher_pid}" ]]; then
    kill "${legacy_partition_watcher_pid}" >/dev/null 2>&1 || true
    wait "${legacy_partition_watcher_pid}" >/dev/null 2>&1 || true
  fi
  exit "${integration_status}"
)
git worktree remove --force "${legacy_worktree}" >/dev/null
legacy_worktree=''

# The historical integration build happened inside the disposable worktree.
# Compile the DB package in the active checkout before the public-web contract imports it.
npm run build --workspace @atodotren/db
node scripts/web-postgres-contract.mjs

echo "PostgreSQL full worker and public-web contracts passed for ${postgres_image}."
