#!/usr/bin/env bash
set -Eeuo pipefail

environment_file="${1:-.env}"
hours="${ATODOTREN_ACCEPTANCE_HOURS:-48}"
minimum_poll_ratio="${ATODOTREN_ACCEPTANCE_MIN_POLL_RATIO:-0.90}"
minimum_success_coverage="${ATODOTREN_ACCEPTANCE_MIN_SUCCESS_COVERAGE:-0.90}"
minimum_polls_override="${ATODOTREN_ACCEPTANCE_MIN_POLLS:-}"

if ! [[ "${hours}" =~ ^[1-9][0-9]*$ ]]; then
  echo 'ATODOTREN_ACCEPTANCE_HOURS must be a positive integer.' >&2
  exit 2
fi
if [[ ! -f "${environment_file}" ]]; then
  echo "Environment file not found: ${environment_file}" >&2
  exit 2
fi
if [[ -n "${minimum_polls_override}" ]] && ! [[ "${minimum_polls_override}" =~ ^[1-9][0-9]*$ ]]; then
  echo 'ATODOTREN_ACCEPTANCE_MIN_POLLS must be a positive integer when set.' >&2
  exit 2
fi
for ratio_setting in \
  "ATODOTREN_ACCEPTANCE_MIN_POLL_RATIO=${minimum_poll_ratio}" \
  "ATODOTREN_ACCEPTANCE_MIN_SUCCESS_COVERAGE=${minimum_success_coverage}"; do
  if ! node -e "const [name, raw] = process.argv[1].split('='); const value=Number(raw); if (!Number.isFinite(value) || value < 0 || value > 1) { console.error(name + ' must be between 0 and 1'); process.exit(1); }" "${ratio_setting}"; then
    exit 2
  fi
done

compose() {
  docker compose --env-file "${environment_file}" "$@"
}

resolved_runtime="$(compose config --format json | node -e "
  let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    const environment = JSON.parse(input).services.worker.environment;
    const enabled = value => String(value).toLowerCase() === 'true';
    console.log(JSON.stringify({
      cycleEnabled: Number(enabled(environment.GTFS_RT_TRIP_UPDATES_ENABLED)) + Number(enabled(environment.GTFS_RT_VEHICLE_POSITIONS_ENABLED)),
      alertsEnabled: Number(enabled(environment.GTFS_RT_SERVICE_ALERTS_ENABLED)),
      cycleIntervalMs: Number(environment.GTFS_RT_CYCLE_INTERVAL_MS),
      alertIntervalMs: Number(environment.GTFS_RT_ALERT_INTERVAL_MS),
      matchingMinimum: Number(environment.INGEST_MATCHING_RATE_MINIMUM),
      malformedMaximum: Number(environment.INGEST_MALFORMED_RATE_MAXIMUM),
    }));
  });
")"

minimum_matching_rate="${ATODOTREN_ACCEPTANCE_MIN_MATCHING_RATE:-$(node -e "console.log(JSON.parse(process.argv[1]).matchingMinimum)" "${resolved_runtime}")}"
maximum_malformed_rate="${ATODOTREN_ACCEPTANCE_MAX_MALFORMED_RATE:-$(node -e "console.log(JSON.parse(process.argv[1]).malformedMaximum)" "${resolved_runtime}")}"
for ratio_setting in \
  "ATODOTREN_ACCEPTANCE_MIN_MATCHING_RATE=${minimum_matching_rate}" \
  "ATODOTREN_ACCEPTANCE_MAX_MALFORMED_RATE=${maximum_malformed_rate}"; do
  if ! node -e "const [name, raw] = process.argv[1].split('='); const value=Number(raw); if (!Number.isFinite(value) || value < 0 || value > 1) { console.error(name + ' must be between 0 and 1'); process.exit(1); }" "${ratio_setting}"; then
    exit 2
  fi
done

read -r expected_polls minimum_polls < <(node -e "
  const runtime=JSON.parse(process.argv[1]);
  const durationMs=Number(process.argv[2]) * 60 * 60 * 1000;
  const cyclePolls=Math.max(1, Math.floor(durationMs / runtime.cycleIntervalMs));
  const effectiveAlertInterval=Math.ceil(runtime.alertIntervalMs / runtime.cycleIntervalMs) * runtime.cycleIntervalMs;
  const alertPolls=Math.max(1, Math.floor(durationMs / effectiveAlertInterval));
  const expected = runtime.cycleEnabled * cyclePolls + runtime.alertsEnabled * alertPolls;
  const override=process.argv[4] === '' ? undefined : Number(process.argv[4]);
  const minimum=override ?? Math.max(1, Math.ceil(expected * Number(process.argv[3])));
  console.log(expected, minimum);
" "${resolved_runtime}" "${hours}" "${minimum_poll_ratio}" "${minimum_polls_override}")

compose up --detach postgres migrate static-import spool-init worker
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
deadline="$(( $(date +%s) + hours * 3600 ))"
metrics_file="$(mktemp /tmp/atodotren-acceptance-metrics.XXXXXX)"
spool_peak=0
trap 'rm -f "${metrics_file}"' EXIT

while [[ "$(date +%s)" -lt "${deadline}" ]]; do
  worker_id="$(compose ps --quiet worker 2>/dev/null || true)"
  if [[ -n "${worker_id}" ]]; then
    docker stats --no-stream --format '{{.CPUPerc}},{{.MemUsage}}' "${worker_id}" >>"${metrics_file}" || true
    if pending_bytes="$(compose exec --no-TTY worker node --input-type=module -e "import { statSync, existsSync } from 'node:fs'; const paths=['/spool/realtime.sqlite','/spool/realtime.sqlite-wal','/spool/realtime.sqlite-shm']; console.log(paths.reduce((n,p)=>n+(existsSync(p)?statSync(p).size:0),0));" 2>/dev/null)"; then
      if [[ "${pending_bytes}" -gt "${spool_peak}" ]]; then spool_peak="${pending_bytes}"; fi
    fi
  fi
  sleep 60
done

worker_running=false
if [[ -n "$(compose ps --status running --quiet worker 2>/dev/null || true)" ]]; then worker_running=true; fi

set +e
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
  'available', true,
  'started_at', '${started_at}',
  'completed_at', clock_timestamp(),
  'polls', (SELECT count(*) FROM polls),
  'successful_polls', (SELECT count(*) FROM polls WHERE result_class = 'success'),
  'successful_poll_coverage', (SELECT COALESCE(round(count(*) FILTER (WHERE result_class = 'success')::numeric / NULLIF(count(*), 0), 4), 0) FROM polls),
  'entity_total', (SELECT COALESCE(sum(entity_total), 0) FROM polls),
  'matched_madrid', (SELECT COALESCE(sum(matched_madrid_count), 0) FROM polls),
  'unmatched', (SELECT COALESCE(sum(unmatched_count), 0) FROM polls),
  'non_madrid', (SELECT COALESCE(sum(non_madrid_count), 0) FROM polls),
  'malformed', (SELECT COALESCE(sum(invalid_count), 0) FROM polls),
  'matching_rate', (SELECT CASE WHEN COALESCE(sum(matched_madrid_count + unmatched_count), 0) = 0 THEN 1 ELSE round(sum(matched_madrid_count)::numeric / sum(matched_madrid_count + unmatched_count), 4) END FROM polls),
  'malformed_rate', (SELECT CASE WHEN COALESCE(sum(entity_total), 0) = 0 THEN 0 ELSE round(sum(invalid_count)::numeric / sum(entity_total), 4) END FROM polls),
  'evidence_changed', (SELECT COALESCE(sum(evidence_changed_count), 0) FROM polls),
  'evidence_repeated', (SELECT COALESCE(sum(evidence_repeated_count), 0) FROM polls),
  'fallback_evidence', (SELECT count(*) FROM ingest.stop_evidence WHERE captured_at >= '${started_at}'::timestamptz AND matching_method LIKE 'previous-%'),
  'ambiguous', (SELECT count(*) FROM ingest.quarantined_entity WHERE captured_at >= '${started_at}'::timestamptz AND reason_code LIKE 'matching.ambiguous%'),
  'quarantined', (SELECT count(*) FROM ingest.quarantined_entity WHERE captured_at >= '${started_at}'::timestamptz),
  'endpoint_failures', (SELECT COALESCE(json_object_agg(feed_kind || '/' || result_class, count), '{}'::json) FROM (SELECT feed_kind, result_class, count(*) FROM polls WHERE result_class <> 'success' GROUP BY feed_kind, result_class) f),
  'relations', (SELECT json_agg(sizes ORDER BY relation) FROM sizes),
  'open_incidents', (SELECT count(*) FROM operations.notification_incident WHERE is_open),
  'incidents', (SELECT COALESCE(json_agg(notification_incident ORDER BY opened_at), '[]'::json) FROM operations.notification_incident),
  'health', (SELECT row_to_json(ingest_health) FROM operations.ingest_health)
);
SQL
)"
report_status=$?
set -e
if [[ ${report_status} -ne 0 || -z "${report}" ]]; then
  report='{"available":false,"error":"database_report_unavailable"}'
fi

set +e
spool_report="$(compose run --rm --no-deps --entrypoint node worker --input-type=module -e "
  import { DatabaseSync } from 'node:sqlite';
  try {
    const database=new DatabaseSync(process.env.SQLITE_SPOOL_PATH, { readOnly: true });
    const pending=database.prepare('SELECT count(*) AS rows, COALESCE(sum(operation_count), 0) AS operations FROM pending_operation').get();
    const dropped=database.prepare('SELECT COALESCE(sum(dropped_count), 0) AS operations FROM dropped_operation').get();
    console.log(JSON.stringify({ available: true, pendingRows: Number(pending.rows), pendingOperations: Number(pending.operations), droppedOperations: Number(dropped.operations) }));
    database.close();
  } catch { console.log(JSON.stringify({ available: false, error: 'spool_report_unavailable' })); process.exitCode=1; }
" 2>/dev/null)"
spool_status=$?
set -e
if [[ ${spool_status} -ne 0 || -z "${spool_report}" ]]; then
  spool_report='{"available":false,"error":"spool_report_unavailable"}'
fi

thresholds="$(node -e "console.log(JSON.stringify({ expectedPolls:Number(process.argv[1]), minimumPolls:Number(process.argv[2]), minimumPollRatio:Number(process.argv[3]), minimumSuccessCoverage:Number(process.argv[4]), minimumMatchingRate:Number(process.argv[5]), maximumMalformedRate:Number(process.argv[6]) }))" \
  "${expected_polls}" "${minimum_polls}" "${minimum_poll_ratio}" "${minimum_success_coverage}" "${minimum_matching_rate}" "${maximum_malformed_rate}")"
gates="$(node -e "
  const report=JSON.parse(process.argv[1]); const spool=JSON.parse(process.argv[2]); const thresholds=JSON.parse(process.argv[3]); const workerRunning=process.argv[4] === 'true';
  const checks=[
    { name:'worker_running', passed:workerRunning, actual:workerRunning, expected:true },
    { name:'database_report', passed:report.available === true, actual:report.available === true, expected:true },
    { name:'minimum_polls', passed:report.available === true && Number(report.polls) >= thresholds.minimumPolls, actual:report.polls ?? null, expected:thresholds.minimumPolls },
    { name:'successful_poll_coverage', passed:report.available === true && Number(report.successful_poll_coverage) >= thresholds.minimumSuccessCoverage, actual:report.successful_poll_coverage ?? null, expected:thresholds.minimumSuccessCoverage },
    { name:'matching_rate', passed:report.available === true && Number(report.matching_rate) >= thresholds.minimumMatchingRate, actual:report.matching_rate ?? null, expected:thresholds.minimumMatchingRate },
    { name:'malformed_rate', passed:report.available === true && Number(report.malformed_rate) <= thresholds.maximumMalformedRate, actual:report.malformed_rate ?? null, expected:thresholds.maximumMalformedRate },
    { name:'spool_pending_operations', passed:spool.available === true && spool.pendingOperations === 0, actual:spool.pendingOperations ?? null, expected:0 },
    { name:'spool_dropped_operations', passed:spool.available === true && spool.droppedOperations === 0, actual:spool.droppedOperations ?? null, expected:0 },
    { name:'open_notification_incidents', passed:report.available === true && Number(report.open_incidents) === 0, actual:report.open_incidents ?? null, expected:0 },
  ];
  console.log(JSON.stringify({ passed:checks.every(check => check.passed), failed:checks.filter(check => !check.passed).length, checks }));
" "${report}" "${spool_report}" "${thresholds}" "${worker_running}")"

printf 'realtime_acceptance %s\n' "${report}"
printf 'realtime_acceptance_spool %s\n' "${spool_report}"
printf 'realtime_acceptance_thresholds %s\n' "${thresholds}"
printf 'realtime_acceptance_gates %s\n' "${gates}"
printf 'realtime_acceptance_spool_peak_bytes %s\n' "${spool_peak}"
printf 'realtime_acceptance_resource_samples\n'
cat "${metrics_file}"
echo "The Compose stack remains running for inspection. Stop it with: docker compose --env-file ${environment_file} down"

if [[ "$(node -e "console.log(JSON.parse(process.argv[1]).passed)" "${gates}")" != 'true' ]]; then
  echo 'Realtime acceptance gates failed; inspect realtime_acceptance_gates above.' >&2
  exit 1
fi
echo 'Realtime acceptance gates passed.'
