-- Pre-pilot correction: stage expected timetable expansion once per eligible finalization.

CREATE OR REPLACE FUNCTION operations.materialize_expected_service_day(
  target_date date,
  algorithm_version text,
  checked_at timestamptz,
  grace_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, operations, analytics, core, gtfs_static
AS $function$
DECLARE
  journey_rows bigint := 0;
  stop_rows bigint := 0;
  ledger_rows bigint := 0;
  expected_journeys bigint := 0;
  expected_stops bigint := 0;
  last_scheduled_end timestamptz;
BEGIN
  IF algorithm_version !~ '^[a-z0-9_.-]{1,40}$' OR grace_seconds < 0 OR grace_seconds > 86400 THEN
    RAISE EXCEPTION 'Invalid expected-service-day materialization parameters';
  END IF;

  IF EXISTS (
    SELECT 1 FROM operations.service_day_finalization
    WHERE service_date = target_date
      AND aggregate_algorithm_version = algorithm_version
      AND status = 'verified'
  ) THEN
    RETURN jsonb_build_object('serviceDate', target_date, 'status', 'already_finalized');
  END IF;

  SELECT COALESCE(sum(expected_journey_count), 0), COALESCE(sum(expected_stop_count), 0),
    max(last_scheduled_end_at)
  INTO expected_journeys, expected_stops, last_scheduled_end
  FROM operations.expected_service_day WHERE service_date = target_date;
  IF expected_journeys > 0 AND last_scheduled_end + make_interval(secs => grace_seconds) > checked_at THEN
    RETURN jsonb_build_object('serviceDate', target_date, 'status', 'blocked',
      'blockers', jsonb_build_array('service_day_grace_not_elapsed'),
      'expectedJourneys', expected_journeys, 'expectedStops', expected_stops,
      'lastScheduledEndAt', last_scheduled_end);
  END IF;

  IF expected_journeys = 0 THEN
    SELECT max(core.service_instant(target_date, stop_time.arrival_seconds, network.timezone))
    INTO last_scheduled_end
    FROM operations.timetable_service_dates(target_date, target_date) AS applicable
    JOIN core.network AS network ON network.id = applicable.network_id
    JOIN gtfs_static.trip AS trip ON trip.feed_version_id = applicable.feed_version_id
    JOIN gtfs_static.calendar_service AS calendar
      ON calendar.feed_version_id = trip.feed_version_id AND calendar.service_id = trip.service_id
    LEFT JOIN gtfs_static.calendar_exception AS exception
      ON exception.feed_version_id = calendar.feed_version_id
     AND exception.service_id = calendar.service_id AND exception.service_date = target_date
    JOIN gtfs_static.stop_time AS stop_time
      ON stop_time.feed_version_id = trip.feed_version_id AND stop_time.trip_id = trip.trip_id
     AND stop_time.arrival_seconds IS NOT NULL
    WHERE CASE
      WHEN exception.exception_type = 1 THEN true
      WHEN exception.exception_type = 2 THEN false
      ELSE target_date BETWEEN calendar.start_date AND calendar.end_date
        AND CASE extract(isodow FROM target_date)::integer
          WHEN 1 THEN calendar.monday WHEN 2 THEN calendar.tuesday WHEN 3 THEN calendar.wednesday
          WHEN 4 THEN calendar.thursday WHEN 5 THEN calendar.friday WHEN 6 THEN calendar.saturday
          ELSE calendar.sunday END
    END;
    IF last_scheduled_end IS NULL THEN
      RETURN jsonb_build_object('serviceDate', target_date, 'status', 'blocked',
        'blockers', jsonb_build_array('no_expected_timetable'), 'expectedJourneys', 0, 'expectedStops', 0);
    END IF;
    IF last_scheduled_end + make_interval(secs => grace_seconds) > checked_at THEN
      RETURN jsonb_build_object('serviceDate', target_date, 'status', 'blocked',
        'blockers', jsonb_build_array('service_day_grace_not_elapsed'),
        'expectedJourneys', 0, 'expectedStops', 0, 'lastScheduledEndAt', last_scheduled_end);
    END IF;
  END IF;

  DROP TABLE IF EXISTS pg_temp.atodotren_expected_timetable_stop;
  CREATE TEMP TABLE atodotren_expected_timetable_stop ON COMMIT DROP AS
  SELECT * FROM operations.expected_timetable_stop(target_date);
  CREATE INDEX ON atodotren_expected_timetable_stop (network_id, source_trip_id, stop_sequence);
  ANALYZE atodotren_expected_timetable_stop;

  INSERT INTO operations.expected_service_day (
    service_date, network_id, feed_version_id, expected_journey_count,
    expected_stop_count, timetable_checksum, last_scheduled_end_at, materialized_at
  )
  SELECT target_date, expected.network_id, expected.feed_version_id,
    count(DISTINCT expected.source_trip_id), count(*),
    encode(sha256(convert_to(string_agg(
      expected.source_trip_id || ':' || expected.stop_sequence || ':' || expected.source_stop_id || ':' ||
      expected.scheduled_arrival_seconds, E'\n' ORDER BY expected.source_trip_id, expected.stop_sequence
    ), 'UTF8')), 'hex'),
    max(core.service_instant(target_date, expected.scheduled_end_seconds, expected.timezone)), checked_at
  FROM atodotren_expected_timetable_stop AS expected
  GROUP BY expected.network_id, expected.feed_version_id
  ON CONFLICT (service_date, network_id) DO UPDATE SET
    feed_version_id = EXCLUDED.feed_version_id,
    expected_journey_count = EXCLUDED.expected_journey_count,
    expected_stop_count = EXCLUDED.expected_stop_count,
    timetable_checksum = EXCLUDED.timetable_checksum,
    last_scheduled_end_at = EXCLUDED.last_scheduled_end_at,
    materialized_at = EXCLUDED.materialized_at;
  GET DIAGNOSTICS ledger_rows = ROW_COUNT;

  SELECT COALESCE(sum(expected_journey_count), 0), COALESCE(sum(expected_stop_count), 0),
    max(last_scheduled_end_at)
  INTO expected_journeys, expected_stops, last_scheduled_end
  FROM operations.expected_service_day WHERE service_date = target_date;
  IF expected_journeys = 0 THEN
    RETURN jsonb_build_object('serviceDate', target_date, 'status', 'blocked',
      'blockers', jsonb_build_array('no_expected_timetable'), 'expectedJourneys', 0, 'expectedStops', 0);
  END IF;

  PERFORM core.ensure_journey_partitions(target_date);

  INSERT INTO core.journey (
    service_date, network_id, feed_version_id, source_trip_id, start_time, start_date_source,
    line_id, branch_id, direction, service_pattern_id, scheduled_start_seconds,
    scheduled_end_seconds, scheduled_start_at, scheduled_end_at, trip_relationship,
    lifecycle_status, matching_method, matching_version, matching_confidence,
    canonical_algorithm_version, first_evidence_at, last_evidence_at, finalized_at,
    opportunity_source
  )
  SELECT DISTINCT expected.service_date, expected.network_id, expected.feed_version_id, expected.source_trip_id,
    NULL::text, 'inferred', expected.line_id, expected.branch_id, expected.direction,
    expected.service_pattern_id, expected.scheduled_start_seconds, expected.scheduled_end_seconds,
    core.service_instant(target_date, expected.scheduled_start_seconds, expected.timezone),
    core.service_instant(target_date, expected.scheduled_end_seconds, expected.timezone),
    'SCHEDULED', 'closed', 'active-exact-trip', 'static-timetable-v1', 1,
    'static-timetable-v1', NULL::timestamptz, NULL::timestamptz, checked_at, 'static_timetable'
  FROM atodotren_expected_timetable_stop AS expected
  WHERE NOT EXISTS (
    SELECT 1 FROM core.journey AS journey
    WHERE journey.service_date = target_date
      AND journey.network_id = expected.network_id
      AND journey.source_trip_id = expected.source_trip_id
  );
  GET DIAGNOSTICS journey_rows = ROW_COUNT;

  INSERT INTO core.journey_stop (
    service_date, journey_id, stop_sequence, station_id, feed_version_id, source_trip_id,
    source_stop_id, scheduled_arrival_seconds, scheduled_arrival_at, evidence_status,
    stop_relationship, matching_method, matching_version, canonical_algorithm_version, finalized_at
  )
  SELECT target_date, journey.id, expected.stop_sequence, expected.station_id,
    expected.feed_version_id, expected.source_trip_id, expected.source_stop_id,
    expected.scheduled_arrival_seconds,
    core.service_instant(target_date, expected.scheduled_arrival_seconds, expected.timezone),
    'missing_evidence', 'SCHEDULED', 'active-exact-trip', 'static-timetable-v1',
    'static-timetable-v1', checked_at
  FROM atodotren_expected_timetable_stop AS expected
  JOIN core.journey AS journey
    ON journey.service_date = target_date
   AND journey.network_id = expected.network_id
   AND journey.source_trip_id = expected.source_trip_id
  WHERE journey.opportunity_source = 'static_timetable'
  ON CONFLICT (service_date, journey_id, stop_sequence) DO NOTHING;
  GET DIAGNOSTICS stop_rows = ROW_COUNT;

  RETURN jsonb_build_object(
    'serviceDate', target_date, 'status', 'materialized', 'journeysCreated', journey_rows,
    'stopsCreated', stop_rows, 'expectedNetworks', ledger_rows,
    'expectedJourneys', expected_journeys, 'expectedStops', expected_stops
  );
END
$function$;
