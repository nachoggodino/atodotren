#!/usr/bin/env bash
set -Eeuo pipefail

environment_file="${1:-.env}"
hours="${ATODOTREN_ACCEPTANCE_HOURS:-48}"
if ! [[ "${hours}" =~ ^[1-9][0-9]*$ ]]; then
  echo 'ATODOTREN_ACCEPTANCE_HOURS must be a positive integer.' >&2
  exit 2
fi
if [[ ! -f "${environment_file}" ]]; then
  echo "Environment file not found: ${environment_file}" >&2
  exit 2
fi

compose() {
  docker compose --env-file "${environment_file}" "$@"
}

compose up --detach postgres migrate static-import spool-init worker
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
deadline="$(( $(date +%s) + hours * 3600 ))"
metrics_file="$(mktemp /tmp/atodotren-acceptance-metrics.XXXXXX)"
spool_peak=0
trap 'rm -f "${metrics_file}"' EXIT

while [[ "$(date +%s)" -lt "${deadline}" ]]; do
  docker stats --no-stream --format '{{.CPUPerc}},{{.MemUsage}}' "$(compose ps --quiet worker)" >>"${metrics_file}" || true
  pending_bytes="$(compose exec --no-TTY worker node --input-type=module -e "import { statSync, existsSync } from 'node:fs'; const paths=['/spool/realtime.sqlite','/spool/realtime.sqlite-wal','/spool/realtime.sqlite-shm']; console.log(paths.reduce((n,p)=>n+(existsSync(p)?statSync(p).size:0),0));")"
  if [[ "${pending_bytes}" -gt "${spool_peak}" ]]; then spool_peak="${pending_bytes}"; fi
  sleep 60
done

report="$(compose exec --no-TTY postgres sh -c 'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align' <<SQL
WITH polls AS (
  SELECT * FROM ingest.poll_run WHERE captured_at >= '${started_at}'::timestamptz
), sizes AS (
  SELECT n.nspname || '.' || c.relname AS relation,
    pg_total_relation_size(c.oid) AS total_bytes,
    pg_indexes_size(c.oid) AS index_bytes
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('ingest', 'operations') AND c.relkind IN ('r', 'p')
)
SELECT json_build_object(
  'started_at', '${started_at}',
  'completed_at', clock_timestamp(),
  'polls', (SELECT count(*) FROM polls),
  'successful_polls', (SELECT count(*) FROM polls WHERE result_class = 'success'),
  'successful_poll_coverage', (SELECT round(count(*) FILTER (WHERE result_class = 'success')::numeric / NULLIF(count(*), 0), 4) FROM polls),
  'matched_madrid', (SELECT COALESCE(sum(matched_madrid_count), 0) FROM polls),
  'unmatched', (SELECT COALESCE(sum(unmatched_count), 0) FROM polls),
  'non_madrid', (SELECT COALESCE(sum(non_madrid_count), 0) FROM polls),
  'malformed', (SELECT COALESCE(sum(invalid_count), 0) FROM polls),
  'evidence_changed', (SELECT COALESCE(sum(evidence_changed_count), 0) FROM polls),
  'evidence_repeated', (SELECT COALESCE(sum(evidence_repeated_count), 0) FROM polls),
  'fallback_evidence', (SELECT count(*) FROM ingest.stop_evidence WHERE captured_at >= '${started_at}'::timestamptz AND matching_method LIKE 'previous-%'),
  'ambiguous', (SELECT count(*) FROM ingest.quarantined_entity WHERE captured_at >= '${started_at}'::timestamptz AND reason_code LIKE 'matching.ambiguous%'),
  'quarantined', (SELECT count(*) FROM ingest.quarantined_entity WHERE captured_at >= '${started_at}'::timestamptz),
  'endpoint_failures', (SELECT COALESCE(json_object_agg(feed_kind || '/' || result_class, count), '{}'::json) FROM (SELECT feed_kind, result_class, count(*) FROM polls WHERE result_class <> 'success' GROUP BY feed_kind, result_class) f),
  'relations', (SELECT json_agg(sizes ORDER BY relation) FROM sizes),
  'incidents', (SELECT COALESCE(json_agg(notification_incident ORDER BY opened_at), '[]'::json) FROM operations.notification_incident),
  'health', (SELECT row_to_json(ingest_health) FROM operations.ingest_health)
);
SQL
)"

printf 'realtime_acceptance %s\n' "${report}"
printf 'realtime_acceptance_spool_peak_bytes %s\n' "${spool_peak}"
printf 'realtime_acceptance_resource_samples\n'
cat "${metrics_file}"
echo 'The Compose stack remains running for inspection. Stop it with: docker compose --env-file .env down'
