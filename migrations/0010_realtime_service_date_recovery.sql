-- Recover service dates omitted by RENFE realtime descriptors and make timetable
-- version selection fall back to the newest archive that actually serves a date.
-- Migrations 0001-0009 are immutable.

SET LOCAL ROLE atodotren_migration_admin;
SET LOCAL statement_timeout = '5min';

ALTER TABLE ingest.stop_evidence
  ADD COLUMN service_date_backfill_attempted_at timestamptz,
  ADD COLUMN service_date_backfill_reason text
    CHECK (service_date_backfill_reason IN (
      'inferred', 'missing_static_schedule', 'no_calendar_candidate', 'ambiguous_or_too_distant'
    )),
  ADD CONSTRAINT stop_evidence_backfill_attempt_consistent CHECK (
    (service_date_backfill_attempted_at IS NULL) = (service_date_backfill_reason IS NULL)
  );

CREATE INDEX stop_evidence_unresolved_captured_idx
  ON ingest.stop_evidence (captured_at, id)
  WHERE service_date IS NULL AND service_date_backfill_attempted_at IS NULL;

CREATE OR REPLACE FUNCTION operations.timetable_service_dates(range_start date, range_end date)
RETURNS TABLE(service_date date, network_id bigint, feed_version_id bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, operations, gtfs_static, core
AS $function$
  WITH dates AS (
    SELECT value::date AS service_date
    FROM generate_series(range_start::timestamp, range_end::timestamp, interval '1 day') AS value
    WHERE range_start <= range_end
  ), serving_versions AS (
    SELECT dates.service_date, version.network_id, version.id AS feed_version_id,
      row_number() OVER (
        PARTITION BY dates.service_date, version.network_id
        ORDER BY version.effective_from DESC NULLS LAST, version.activated_at DESC, version.id DESC
      ) AS preference
    FROM dates
    JOIN gtfs_static.feed_version AS version
      ON version.status IN ('active', 'superseded')
     AND (version.effective_from IS NULL OR version.effective_from <= dates.service_date)
     AND (version.effective_until IS NULL OR version.effective_until >= dates.service_date)
    WHERE EXISTS (
      SELECT 1
      FROM gtfs_static.trip AS trip
      JOIN gtfs_static.calendar_service AS calendar
        ON calendar.feed_version_id = trip.feed_version_id AND calendar.service_id = trip.service_id
      LEFT JOIN gtfs_static.calendar_exception AS exception
        ON exception.feed_version_id = calendar.feed_version_id
       AND exception.service_id = calendar.service_id
       AND exception.service_date = dates.service_date
      JOIN gtfs_static.trip_pattern_map AS pattern_map
        ON pattern_map.feed_version_id = trip.feed_version_id AND pattern_map.trip_id = trip.trip_id
      WHERE trip.feed_version_id = version.id
        AND CASE
          WHEN exception.exception_type = 1 THEN true
          WHEN exception.exception_type = 2 THEN false
          ELSE dates.service_date BETWEEN calendar.start_date AND calendar.end_date
            AND CASE extract(isodow FROM dates.service_date)::integer
              WHEN 1 THEN calendar.monday WHEN 2 THEN calendar.tuesday WHEN 3 THEN calendar.wednesday
              WHEN 4 THEN calendar.thursday WHEN 5 THEN calendar.friday WHEN 6 THEN calendar.saturday
              ELSE calendar.sunday END
        END
    )
  )
  SELECT candidate.service_date, candidate.network_id, candidate.feed_version_id
  FROM serving_versions AS candidate
  WHERE candidate.preference = 1
$function$;

CREATE OR REPLACE FUNCTION operations.backfill_realtime_service_dates(batch_limit integer DEFAULT 5000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, operations, ingest, gtfs_static, core
AS $function$
DECLARE
  scanned_rows bigint := 0;
  updated_rows bigint := 0;
  unresolved_rows bigint := 0;
  remaining_eligible_rows bigint := 0;
  remaining_rows bigint := 0;
BEGIN
  IF batch_limit IS NULL OR batch_limit < 1 OR batch_limit > 50000 THEN
    RAISE EXCEPTION 'Backfill batch limit must be from 1 through 50000';
  END IF;

  WITH target AS MATERIALIZED (
    SELECT evidence.captured_at, evidence.id, evidence.feed_version_id,
      evidence.source_trip_id, evidence.stop_sequence,
      COALESCE(
        evidence.renfe_arrival_time,
        evidence.source_timestamp,
        extract(epoch FROM evidence.captured_at)::bigint
      ) AS anchor_seconds
    FROM ingest.stop_evidence AS evidence
    WHERE evidence.service_date IS NULL
      AND evidence.service_date_backfill_attempted_at IS NULL
    ORDER BY evidence.captured_at, evidence.id
    LIMIT batch_limit
    FOR UPDATE SKIP LOCKED
  ), inputs AS (
    SELECT target.*,
      trip.service_id,
      network.timezone,
      COALESCE(stop_time.arrival_seconds, first_stop.arrival_seconds) AS scheduled_seconds
    FROM target
    JOIN gtfs_static.trip AS trip
      ON trip.feed_version_id = target.feed_version_id AND trip.trip_id = target.source_trip_id
    JOIN gtfs_static.feed_version AS version ON version.id = trip.feed_version_id
    JOIN core.network AS network ON network.id = version.network_id
    LEFT JOIN gtfs_static.stop_time AS stop_time
      ON stop_time.feed_version_id = target.feed_version_id
     AND stop_time.trip_id = target.source_trip_id
     AND stop_time.stop_sequence = target.stop_sequence
    JOIN LATERAL (
      SELECT COALESCE(value.arrival_seconds, value.departure_seconds) AS arrival_seconds
      FROM gtfs_static.stop_time AS value
      WHERE value.feed_version_id = target.feed_version_id
        AND value.trip_id = target.source_trip_id
        AND COALESCE(value.arrival_seconds, value.departure_seconds) IS NOT NULL
      ORDER BY value.stop_sequence
      LIMIT 1
    ) AS first_stop ON true
    WHERE COALESCE(stop_time.arrival_seconds, first_stop.arrival_seconds) IS NOT NULL
  ), candidates AS (
    SELECT inputs.captured_at, inputs.id, candidate_date.service_date,
      abs(inputs.anchor_seconds - extract(epoch FROM core.service_instant(
        candidate_date.service_date,
        inputs.scheduled_seconds,
        inputs.timezone
      ))) AS distance_seconds
    FROM inputs
    CROSS JOIN LATERAL (
      SELECT value::date AS service_date
      FROM generate_series(
        (to_timestamp(inputs.anchor_seconds) AT TIME ZONE inputs.timezone)::date - 4,
        (to_timestamp(inputs.anchor_seconds) AT TIME ZONE inputs.timezone)::date + 1,
        interval '1 day'
      ) AS value
    ) AS candidate_date
    JOIN gtfs_static.calendar_service AS calendar
      ON calendar.feed_version_id = inputs.feed_version_id AND calendar.service_id = inputs.service_id
    LEFT JOIN gtfs_static.calendar_exception AS exception
      ON exception.feed_version_id = calendar.feed_version_id
     AND exception.service_id = calendar.service_id
     AND exception.service_date = candidate_date.service_date
    WHERE CASE
      WHEN exception.exception_type = 1 THEN true
      WHEN exception.exception_type = 2 THEN false
      ELSE candidate_date.service_date BETWEEN calendar.start_date AND calendar.end_date
        AND CASE extract(isodow FROM candidate_date.service_date)::integer
          WHEN 1 THEN calendar.monday WHEN 2 THEN calendar.tuesday WHEN 3 THEN calendar.wednesday
          WHEN 4 THEN calendar.thursday WHEN 5 THEN calendar.friday WHEN 6 THEN calendar.saturday
          ELSE calendar.sunday END
    END
  ), ranked AS (
    SELECT candidates.*,
      row_number() OVER (
        PARTITION BY candidates.captured_at, candidates.id
        ORDER BY candidates.distance_seconds, candidates.service_date
      ) AS preference,
      lead(candidates.distance_seconds) OVER (
        PARTITION BY candidates.captured_at, candidates.id
        ORDER BY candidates.distance_seconds, candidates.service_date
      ) AS next_distance_seconds
    FROM candidates
  ), best AS (
    SELECT captured_at, id, service_date, distance_seconds, next_distance_seconds
    FROM ranked
    WHERE preference = 1
  ), resolved AS (
    SELECT captured_at, id, service_date
    FROM best
    WHERE distance_seconds <= 64800
      AND (next_distance_seconds IS NULL OR next_distance_seconds <> distance_seconds)
  ), marked AS (
    UPDATE ingest.stop_evidence AS evidence
    SET service_date = resolved.service_date,
      start_date_source = CASE WHEN resolved.service_date IS NULL
        THEN evidence.start_date_source ELSE 'inferred' END,
      service_date_backfill_attempted_at = clock_timestamp(),
      service_date_backfill_reason = CASE
        WHEN resolved.service_date IS NOT NULL THEN 'inferred'
        WHEN inputs.id IS NULL THEN 'missing_static_schedule'
        WHEN best.id IS NULL THEN 'no_calendar_candidate'
        ELSE 'ambiguous_or_too_distant'
      END
    FROM target
    LEFT JOIN inputs
      ON inputs.captured_at = target.captured_at AND inputs.id = target.id
    LEFT JOIN best
      ON best.captured_at = target.captured_at AND best.id = target.id
    LEFT JOIN resolved
      ON resolved.captured_at = target.captured_at AND resolved.id = target.id
    WHERE evidence.captured_at = target.captured_at AND evidence.id = target.id
    RETURNING resolved.service_date IS NOT NULL AS was_resolved
  )
  SELECT count(*)::bigint,
    count(*) FILTER (WHERE was_resolved)::bigint,
    count(*) FILTER (WHERE NOT was_resolved)::bigint
  INTO scanned_rows, updated_rows, unresolved_rows
  FROM marked;

  SELECT count(*) INTO remaining_eligible_rows
  FROM ingest.stop_evidence
  WHERE service_date IS NULL AND service_date_backfill_attempted_at IS NULL;

  SELECT count(*) INTO remaining_rows
  FROM ingest.stop_evidence
  WHERE service_date IS NULL;

  RETURN jsonb_build_object(
    'scanned', scanned_rows,
    'updated', updated_rows,
    'unresolved', unresolved_rows,
    'remainingEligible', remaining_eligible_rows,
    'remaining', remaining_rows,
    'batchLimit', batch_limit
  );
END
$function$;

REVOKE ALL ON FUNCTION operations.backfill_realtime_service_dates(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operations.backfill_realtime_service_dates(integer) TO atodotren_ingest_writer;

CREATE OR REPLACE FUNCTION operations.summarize_operations_date(target_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, operations, ingest
AS $function$
DECLARE
  poll_rows bigint;
  quarantine_rows bigint;
  day_start timestamptz := target_date::timestamp AT TIME ZONE 'Europe/Madrid';
  day_end timestamptz := (target_date + 1)::timestamp AT TIME ZONE 'Europe/Madrid';
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('operations-summary:' || target_date::text, 0));
  DELETE FROM operations.daily_feed_coverage WHERE service_date = target_date;
  INSERT INTO operations.daily_feed_coverage (
    service_date, feed_kind, poll_count, successful_poll_count, matched_madrid_count,
    non_madrid_count, unmatched_count, invalid_count, evidence_changed_count,
    response_bytes, first_poll_at, last_poll_at, source_checksum
  )
  SELECT target_date, feed_kind, count(*)::bigint,
    count(*) FILTER (WHERE result_class = 'success')::bigint,
    sum(matched_madrid_count)::bigint, sum(non_madrid_count)::bigint, sum(unmatched_count)::bigint,
    sum(invalid_count)::bigint, sum(evidence_changed_count)::bigint, sum(response_bytes)::bigint,
    min(captured_at), max(captured_at),
    encode(sha256(convert_to(COALESCE(string_agg(idempotency_key || ':' || result_class || ':' || matched_madrid_count || ':' || unmatched_count || ':' || invalid_count, E'\n' ORDER BY idempotency_key), ''), 'UTF8')), 'hex')
  FROM ingest.poll_run
  WHERE captured_at >= day_start AND captured_at < day_end
  GROUP BY feed_kind;
  GET DIAGNOSTICS poll_rows = ROW_COUNT;

  DELETE FROM operations.daily_quarantine_summary WHERE service_date = target_date;
  INSERT INTO operations.daily_quarantine_summary (service_date, reason_code, entity_count, source_checksum)
  SELECT target_date, reason_code, count(*)::bigint,
    encode(sha256(convert_to(COALESCE(string_agg(idempotency_key, E'\n' ORDER BY idempotency_key), ''), 'UTF8')), 'hex')
  FROM ingest.quarantined_entity
  WHERE captured_at >= day_start AND captured_at < day_end
  GROUP BY reason_code;
  GET DIAGNOSTICS quarantine_rows = ROW_COUNT;
  RETURN jsonb_build_object('serviceDate', target_date, 'feedRows', poll_rows, 'quarantineRows', quarantine_rows);
END
$function$;

REVOKE ALL ON FUNCTION operations.summarize_operations_date(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operations.summarize_operations_date(date) TO atodotren_ingest_writer;

CREATE OR REPLACE VIEW operations.report_ingest_health
WITH (security_barrier = true)
AS
SELECT
  health.last_durable_cycle_at,
  health.last_postgres_cycle_at,
  health.consecutive_failures,
  health.spool_pending_count,
  health.spool_bytes,
  health.spool_dropped_count,
  health.updated_at,
  (SELECT max(poll.captured_at) FROM ingest.poll_run AS poll WHERE poll.result_class = 'success') AS latest_successful_poll_at,
  (SELECT count(*) FROM ingest.live_vehicle_state) AS live_vehicle_count,
  (SELECT count(*) FROM operations.notification_incident AS incident WHERE incident.is_open) AS open_incident_count,
  (SELECT count(*) FROM ingest.live_vehicle_state AS vehicle
    WHERE vehicle.captured_at >= clock_timestamp() - interval '5 minutes') AS fresh_vehicle_count,
  (SELECT count(*) FROM ingest.stop_evidence AS evidence
    WHERE evidence.service_date IS NULL) AS unresolved_evidence_count
FROM operations.ingest_health AS health;

CREATE OR REPLACE VIEW operations.report_feed_coverage
WITH (security_barrier = true)
AS
SELECT summary.service_date, summary.feed_kind, summary.poll_count, summary.successful_poll_count,
  summary.matched_madrid_count, summary.non_madrid_count, summary.unmatched_count,
  summary.invalid_count, summary.evidence_changed_count, summary.response_bytes,
  summary.first_poll_at, summary.last_poll_at
FROM operations.daily_feed_coverage AS summary
UNION ALL
SELECT live.service_date, live.feed_kind, count(*)::bigint,
  count(*) FILTER (WHERE live.result_class = 'success')::bigint,
  sum(live.matched_madrid_count)::bigint, sum(live.non_madrid_count)::bigint,
  sum(live.unmatched_count)::bigint, sum(live.invalid_count)::bigint,
  sum(live.evidence_changed_count)::bigint, sum(live.response_bytes)::bigint,
  min(live.captured_at), max(live.captured_at)
FROM (
  SELECT poll.*, (poll.captured_at AT TIME ZONE 'Europe/Madrid')::date AS service_date
  FROM ingest.poll_run AS poll
) AS live
WHERE NOT EXISTS (
  SELECT 1 FROM operations.daily_feed_coverage AS summary
  WHERE summary.service_date = live.service_date AND summary.feed_kind = live.feed_kind
)
GROUP BY live.service_date, live.feed_kind;
