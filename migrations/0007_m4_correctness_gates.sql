-- Milestone 4 review corrections: timetable denominators, civil-time identity,
-- complete sealing inputs, and evidence-watermark retention gates.

SET LOCAL ROLE atodotren_migration_admin;

ALTER TABLE core.journey
  ADD COLUMN opportunity_source text NOT NULL DEFAULT 'realtime_evidence'
    CHECK (opportunity_source IN ('realtime_evidence', 'static_timetable'));
ALTER TABLE core.journey ALTER COLUMN first_evidence_at DROP NOT NULL;
ALTER TABLE core.journey ALTER COLUMN last_evidence_at DROP NOT NULL;
ALTER TABLE core.journey ADD CONSTRAINT journey_evidence_watermark_consistent CHECK (
  (opportunity_source = 'static_timetable' AND first_evidence_at IS NULL AND last_evidence_at IS NULL)
  OR (opportunity_source = 'realtime_evidence' AND first_evidence_at IS NOT NULL AND last_evidence_at IS NOT NULL)
);

CREATE OR REPLACE FUNCTION core.guard_canonical_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  old_closed boolean;
  timetable_claim boolean := false;
BEGIN
  IF to_jsonb(OLD) ? 'journey_id' THEN
    SELECT finalized_at IS NOT NULL INTO old_closed
    FROM core.journey
    WHERE service_date = OLD.service_date AND id = OLD.journey_id;
    IF OLD.first_stopped_presence_at IS NOT NULL
      AND NEW.first_stopped_presence_at IS DISTINCT FROM OLD.first_stopped_presence_at
    THEN RAISE EXCEPTION 'First stopped presence is immutable'; END IF;
  ELSE
    old_closed := OLD.finalized_at IS NOT NULL;
    timetable_claim := OLD.opportunity_source = 'static_timetable'
      AND NEW.opportunity_source = 'realtime_evidence'
      AND OLD.service_date = NEW.service_date
      AND OLD.network_id = NEW.network_id
      AND OLD.source_trip_id = NEW.source_trip_id
      AND OLD.line_id = NEW.line_id AND OLD.branch_id = NEW.branch_id
      AND OLD.service_pattern_id = NEW.service_pattern_id
      AND OLD.scheduled_start_seconds = NEW.scheduled_start_seconds
      AND OLD.scheduled_end_seconds = NEW.scheduled_end_seconds
      AND NEW.repair_version = OLD.repair_version
      AND NEW.first_evidence_at IS NOT NULL AND NEW.last_evidence_at IS NOT NULL
      AND NEW.finalized_at IS NULL AND NEW.lifecycle_status = 'open'
      AND EXISTS (
        SELECT 1 FROM gtfs_static.feed_version AS version
        WHERE version.id = NEW.feed_version_id AND version.network_id = NEW.network_id
      );
    IF NEW.finalized_at IS NOT NULL AND OLD.finalized_at IS NULL AND EXISTS (
      SELECT 1 FROM core.journey_stop
      WHERE service_date = OLD.service_date AND journey_id = OLD.id
        AND evidence_status = 'pending'
    ) THEN RAISE EXCEPTION 'Cannot finalize journey with pending stops'; END IF;
  END IF;
  IF old_closed AND NOT timetable_claim AND NOT (
    NEW.repair_version > OLD.repair_version
    AND NEW.repaired_at IS NOT NULL
    AND NEW.canonical_algorithm_version <> OLD.canonical_algorithm_version
  ) THEN RAISE EXCEPTION 'Closed canonical rows require an explicit versioned repair'; END IF;
  RETURN NEW;
END
$function$;

CREATE TABLE operations.expected_service_day (
  service_date date NOT NULL,
  network_id bigint NOT NULL REFERENCES core.network(id),
  feed_version_id bigint NOT NULL REFERENCES gtfs_static.feed_version(id),
  expected_journey_count bigint NOT NULL CHECK (expected_journey_count > 0),
  expected_stop_count bigint NOT NULL CHECK (expected_stop_count > 0),
  timetable_checksum text NOT NULL CHECK (timetable_checksum ~ '^[0-9a-f]{64}$'),
  last_scheduled_end_at timestamptz NOT NULL,
  materialized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (service_date, network_id)
);

CREATE TABLE operations.calendar_classification (
  service_date date NOT NULL,
  network_id bigint NOT NULL REFERENCES core.network(id),
  day_class text NOT NULL CHECK (day_class IN ('holiday', 'weekend', 'ordinary_weekday')),
  classification_version text NOT NULL CHECK (classification_version ~ '^[a-z0-9_.-]{1,40}$'),
  published_at date NOT NULL,
  source_uri text NOT NULL CHECK (btrim(source_uri) <> ''),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 200),
  PRIMARY KEY (service_date, network_id, classification_version)
);

INSERT INTO operations.calendar_classification (
  service_date, network_id, day_class, classification_version, published_at, source_uri, reason
)
SELECT holiday_date, network.id, 'holiday', 'madrid-2026-v1', date '2025-09-25',
  'https://www.comunidad.madrid/empleo/calendario-laboral-comunidad-madrid-municipios',
  'Decreto 75/2025: fiesta laboral de la Comunidad de Madrid'
FROM core.network AS network
CROSS JOIN unnest(ARRAY[
  date '2026-01-01', date '2026-01-06', date '2026-04-02', date '2026-04-03',
  date '2026-05-01', date '2026-05-02', date '2026-08-15', date '2026-10-12',
  date '2026-11-02', date '2026-12-07', date '2026-12-08', date '2026-12-25'
]) AS holiday_date
WHERE network.slug = 'madrid';

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
  ), applicable_versions AS (
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
  )
  SELECT applicable.service_date, applicable.network_id, applicable.feed_version_id
  FROM applicable_versions AS applicable
  WHERE applicable.preference = 1
    AND EXISTS (
      SELECT 1
      FROM gtfs_static.trip AS trip
      JOIN gtfs_static.calendar_service AS calendar
        ON calendar.feed_version_id = trip.feed_version_id AND calendar.service_id = trip.service_id
      LEFT JOIN gtfs_static.calendar_exception AS exception
        ON exception.feed_version_id = calendar.feed_version_id
       AND exception.service_id = calendar.service_id
       AND exception.service_date = applicable.service_date
      JOIN gtfs_static.trip_pattern_map AS pattern_map
        ON pattern_map.feed_version_id = trip.feed_version_id AND pattern_map.trip_id = trip.trip_id
      WHERE trip.feed_version_id = applicable.feed_version_id
        AND CASE
          WHEN exception.exception_type = 1 THEN true
          WHEN exception.exception_type = 2 THEN false
          ELSE applicable.service_date BETWEEN calendar.start_date AND calendar.end_date
            AND CASE extract(isodow FROM applicable.service_date)::integer
              WHEN 1 THEN calendar.monday WHEN 2 THEN calendar.tuesday WHEN 3 THEN calendar.wednesday
              WHEN 4 THEN calendar.thursday WHEN 5 THEN calendar.friday WHEN 6 THEN calendar.saturday
              ELSE calendar.sunday END
        END
    )
$function$;

CREATE OR REPLACE FUNCTION operations.expected_timetable_stop(target_date date)
RETURNS TABLE(
  service_date date, network_id bigint, feed_version_id bigint, source_trip_id text,
  line_id bigint, branch_id bigint, direction smallint, service_pattern_id bigint,
  timezone text, scheduled_start_seconds integer, scheduled_end_seconds integer,
  stop_sequence integer, station_id bigint, source_stop_id text,
  scheduled_arrival_seconds integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, operations, gtfs_static, core
AS $function$
  WITH applicable AS (
    SELECT * FROM operations.timetable_service_dates(target_date, target_date)
  ), active_trips AS (
    SELECT applicable.service_date, applicable.network_id, applicable.feed_version_id,
      trip.trip_id, route_map.line_id, pattern_map.branch_id, trip.direction_id,
      pattern_map.service_pattern_id, network.timezone
    FROM applicable
    JOIN core.network AS network ON network.id = applicable.network_id
    JOIN gtfs_static.trip AS trip ON trip.feed_version_id = applicable.feed_version_id
    JOIN gtfs_static.calendar_service AS calendar
      ON calendar.feed_version_id = trip.feed_version_id AND calendar.service_id = trip.service_id
    LEFT JOIN gtfs_static.calendar_exception AS exception
      ON exception.feed_version_id = calendar.feed_version_id
     AND exception.service_id = calendar.service_id AND exception.service_date = target_date
    JOIN gtfs_static.route_line_map AS route_map
      ON route_map.feed_version_id = trip.feed_version_id AND route_map.route_id = trip.route_id
    JOIN gtfs_static.trip_pattern_map AS pattern_map
      ON pattern_map.feed_version_id = trip.feed_version_id AND pattern_map.trip_id = trip.trip_id
    WHERE CASE
      WHEN exception.exception_type = 1 THEN true
      WHEN exception.exception_type = 2 THEN false
      ELSE target_date BETWEEN calendar.start_date AND calendar.end_date
        AND CASE extract(isodow FROM target_date)::integer
          WHEN 1 THEN calendar.monday WHEN 2 THEN calendar.tuesday WHEN 3 THEN calendar.wednesday
          WHEN 4 THEN calendar.thursday WHEN 5 THEN calendar.friday WHEN 6 THEN calendar.saturday
          ELSE calendar.sunday END
    END
  )
  SELECT trip.service_date, trip.network_id, trip.feed_version_id, trip.trip_id,
    trip.line_id, trip.branch_id, trip.direction_id, trip.service_pattern_id, trip.timezone,
    min(stop_time.arrival_seconds) OVER (PARTITION BY trip.feed_version_id, trip.trip_id),
    max(stop_time.arrival_seconds) OVER (PARTITION BY trip.feed_version_id, trip.trip_id),
    stop_time.stop_sequence, station_map.station_id, stop_time.stop_id, stop_time.arrival_seconds
  FROM active_trips AS trip
  JOIN gtfs_static.stop_time AS stop_time
    ON stop_time.feed_version_id = trip.feed_version_id AND stop_time.trip_id = trip.trip_id
   AND stop_time.arrival_seconds IS NOT NULL
  JOIN gtfs_static.stop_station_map AS station_map
    ON station_map.feed_version_id = stop_time.feed_version_id AND station_map.stop_id = stop_time.stop_id
$function$;

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
  FROM operations.expected_timetable_stop(target_date) AS expected
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
  IF last_scheduled_end + make_interval(secs => grace_seconds) > checked_at THEN
    RETURN jsonb_build_object('serviceDate', target_date, 'status', 'blocked',
      'blockers', jsonb_build_array('service_day_grace_not_elapsed'),
      'expectedJourneys', expected_journeys, 'expectedStops', expected_stops,
      'lastScheduledEndAt', last_scheduled_end);
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
  FROM operations.expected_timetable_stop(target_date) AS expected
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
  SELECT target_date, journey.id, stop_time.stop_sequence, station_map.station_id,
    stop_time.feed_version_id, stop_time.trip_id, stop_time.stop_id, stop_time.arrival_seconds,
    core.service_instant(target_date, stop_time.arrival_seconds, network.timezone),
    'missing_evidence', 'SCHEDULED', 'active-exact-trip', 'static-timetable-v1',
    'static-timetable-v1', checked_at
  FROM core.journey AS journey
  JOIN core.network AS network ON network.id = journey.network_id
  JOIN gtfs_static.stop_time AS stop_time
    ON stop_time.feed_version_id = journey.feed_version_id AND stop_time.trip_id = journey.source_trip_id
   AND stop_time.arrival_seconds IS NOT NULL
  JOIN gtfs_static.stop_station_map AS station_map
    ON station_map.feed_version_id = stop_time.feed_version_id AND station_map.stop_id = stop_time.stop_id
  WHERE journey.service_date = target_date
    AND journey.opportunity_source = 'static_timetable'
  ON CONFLICT (service_date, journey_id, stop_sequence) DO NOTHING;
  GET DIAGNOSTICS stop_rows = ROW_COUNT;

  RETURN jsonb_build_object(
    'serviceDate', target_date, 'status', 'materialized', 'journeysCreated', journey_rows,
    'stopsCreated', stop_rows, 'expectedNetworks', ledger_rows,
    'expectedJourneys', expected_journeys, 'expectedStops', expected_stops
  );
END
$function$;

ALTER TABLE analytics.daily_schedule_contribution
  ADD COLUMN service_day_seconds integer CHECK (service_day_seconds BETWEEN 0 AND 359999),
  ADD COLUMN civil_date date,
  ADD COLUMN day_class text CHECK (day_class IN ('holiday', 'weekend', 'ordinary_weekday')),
  ADD COLUMN calendar_classification_version text;

CREATE OR REPLACE FUNCTION analytics.classify_schedule_contribution()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, analytics, operations
AS $function$
DECLARE
  configured operations.calendar_classification%ROWTYPE;
BEGIN
  NEW.service_day_seconds := NEW.scheduled_seconds;
  NEW.civil_date := NEW.service_date + (NEW.scheduled_seconds / 86400);
  NEW.weekday_class := analytics.weekday_class(NEW.civil_date);
  NEW.scheduled_seconds := NEW.scheduled_seconds % 86400;
  SELECT * INTO configured
  FROM operations.calendar_classification
  WHERE service_date = NEW.civil_date AND network_id = NEW.network_id
  ORDER BY published_at DESC, classification_version DESC LIMIT 1;
  NEW.day_class := COALESCE(configured.day_class,
    CASE WHEN extract(isodow FROM NEW.civil_date)::integer IN (6, 7)
      THEN 'weekend' ELSE 'ordinary_weekday' END);
  NEW.calendar_classification_version := COALESCE(configured.classification_version, 'calendar-v1');
  RETURN NEW;
END
$function$;

CREATE TRIGGER daily_schedule_civil_identity
BEFORE INSERT ON analytics.daily_schedule_contribution
FOR EACH ROW EXECUTE FUNCTION analytics.classify_schedule_contribution();

-- Compact classified exact-schedule facts have no daily identity or service_date.
CREATE TABLE analytics.monthly_schedule_classification (
  calendar_month date NOT NULL CHECK (calendar_month = date_trunc('month', calendar_month)::date),
  family text NOT NULL CHECK (family IN ('stop', 'segment', 'journey')),
  weekday_class text NOT NULL,
  day_class text NOT NULL CHECK (day_class IN ('holiday', 'weekend', 'ordinary_weekday')),
  calendar_classification_version text NOT NULL,
  network_id bigint NOT NULL REFERENCES core.network(id),
  feed_version_id bigint NOT NULL REFERENCES gtfs_static.feed_version(id),
  service_pattern_id bigint NOT NULL REFERENCES core.service_pattern(id),
  line_id bigint NOT NULL REFERENCES core.line(id),
  branch_id bigint NOT NULL REFERENCES core.branch(id),
  direction smallint NOT NULL CHECK (direction IN (0, 1)),
  station_id bigint REFERENCES core.station(id),
  segment_id bigint REFERENCES core.segment(id),
  scheduled_seconds integer NOT NULL CHECK (scheduled_seconds BETWEEN 0 AND 86399),
  service_day_seconds integer NOT NULL CHECK (service_day_seconds BETWEEN 0 AND 359999),
  scheduled_opportunities bigint NOT NULL CHECK (scheduled_opportunities >= 0),
  valid_delay_observations bigint NOT NULL CHECK (valid_delay_observations >= 0),
  punctual_count bigint NOT NULL, early_count bigint NOT NULL, zero_to_two_count bigint NOT NULL,
  over_two_to_five_count bigint NOT NULL, over_five_to_ten_count bigint NOT NULL,
  over_ten_to_fifteen_count bigint NOT NULL, over_fifteen_count bigint NOT NULL,
  canceled_count bigint NOT NULL, skipped_count bigint NOT NULL, missing_evidence_count bigint NOT NULL,
  pending_count bigint NOT NULL, reported_only_count bigint NOT NULL, observed_presence_count bigint NOT NULL,
  discrepancy_count bigint NOT NULL, signed_delay_sum bigint NOT NULL, squared_delay_sum numeric NOT NULL,
  minimum_delay_seconds integer, maximum_delay_seconds integer,
  histogram_version text NOT NULL CHECK (histogram_version = 'h30-v1'),
  delay_histogram integer[] NOT NULL CHECK (array_length(delay_histogram, 1) = 72),
  source_coverage numeric(9,8) NOT NULL CHECK (source_coverage BETWEEN 0 AND 1),
  aggregate_algorithm_version text NOT NULL,
  UNIQUE NULLS NOT DISTINCT (
    calendar_month, family, weekday_class, day_class, calendar_classification_version,
    network_id, feed_version_id, service_pattern_id, line_id, branch_id, direction,
    station_id, segment_id, scheduled_seconds, service_day_seconds, aggregate_algorithm_version
  )
);
CREATE INDEX monthly_schedule_classification_query_idx
  ON analytics.monthly_schedule_classification (
    family, day_class, calendar_classification_version, weekday_class,
    scheduled_seconds, calendar_month
  );

CREATE OR REPLACE FUNCTION analytics.compact_sealed_schedule_classification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, analytics
AS $function$
DECLARE
  sealing_month date;
  sealing_algorithm text;
BEGIN
  sealing_month := NULLIF(current_setting('atodotren.sealing_month', true), '')::date;
  sealing_algorithm := NULLIF(current_setting('atodotren.sealing_algorithm', true), '');
  IF sealing_month IS NULL OR sealing_algorithm IS NULL THEN RETURN NULL; END IF;
  INSERT INTO analytics.monthly_schedule_classification (
    calendar_month, family, weekday_class, day_class, calendar_classification_version,
    network_id, feed_version_id, service_pattern_id, line_id, branch_id, direction,
    station_id, segment_id, scheduled_seconds, service_day_seconds,
    scheduled_opportunities, valid_delay_observations, punctual_count, early_count,
    zero_to_two_count, over_two_to_five_count, over_five_to_ten_count,
    over_ten_to_fifteen_count, over_fifteen_count, canceled_count, skipped_count,
    missing_evidence_count, pending_count, reported_only_count, observed_presence_count,
    discrepancy_count, signed_delay_sum, squared_delay_sum, minimum_delay_seconds,
    maximum_delay_seconds, histogram_version, delay_histogram, source_coverage,
    aggregate_algorithm_version
  )
  SELECT sealing_month, family, weekday_class, day_class, calendar_classification_version,
    network_id, feed_version_id, service_pattern_id, line_id, branch_id, direction,
    station_id, segment_id, scheduled_seconds, service_day_seconds,
    sum(scheduled_opportunities), sum(valid_delay_observations), sum(punctual_count), sum(early_count),
    sum(zero_to_two_count), sum(over_two_to_five_count), sum(over_five_to_ten_count),
    sum(over_ten_to_fifteen_count), sum(over_fifteen_count), sum(canceled_count), sum(skipped_count),
    sum(missing_evidence_count), sum(pending_count), sum(reported_only_count), sum(observed_presence_count),
    sum(discrepancy_count), sum(signed_delay_sum), sum(squared_delay_sum), min(minimum_delay_seconds),
    max(maximum_delay_seconds), 'h30-v1', analytics.histogram_sum(delay_histogram),
    CASE WHEN sum(scheduled_opportunities) = 0 THEN 0
      ELSE (sum(valid_delay_observations)::numeric / sum(scheduled_opportunities)::numeric)::numeric(9,8) END,
    aggregate_algorithm_version
  FROM deleted_schedule_contribution
  WHERE aggregate_algorithm_version = sealing_algorithm
  GROUP BY family, weekday_class, day_class, calendar_classification_version,
    network_id, feed_version_id, service_pattern_id, line_id, branch_id, direction,
    station_id, segment_id, scheduled_seconds, service_day_seconds, aggregate_algorithm_version;
  RETURN NULL;
END
$function$;

CREATE TRIGGER compact_classification_on_successful_seal
AFTER DELETE ON analytics.daily_schedule_contribution
REFERENCING OLD TABLE AS deleted_schedule_contribution
FOR EACH STATEMENT EXECUTE FUNCTION analytics.compact_sealed_schedule_classification();

CREATE OR REPLACE FUNCTION analytics.canonical_source_checksum(target_date date)
RETURNS text
LANGUAGE sql
STABLE
STRICT
PARALLEL SAFE
AS $function$
  WITH source_rows AS (
    SELECT 'j|' || j.id || '|' || j.network_id || '|' || j.feed_version_id || '|' || j.source_trip_id || '|' ||
      COALESCE(j.start_time, '') || '|' || j.line_id || '|' || j.branch_id || '|' || COALESCE(j.direction::text, '') || '|' ||
      j.service_pattern_id || '|' || j.scheduled_start_seconds || '|' || j.scheduled_end_seconds || '|' || j.lifecycle_status || '|' ||
      j.opportunity_source || '|' || COALESCE(j.first_evidence_at::text, '') || '|' ||
      COALESCE(j.last_evidence_at::text, '') || '|' || COALESCE(j.finalized_at::text, '') || '|' ||
      j.canonical_algorithm_version || '|' || j.revision || '|' || j.repair_version AS payload
    FROM core.journey AS j WHERE j.service_date = target_date
    UNION ALL
    SELECT 's|' || s.journey_id || '|' || s.stop_sequence || '|' || s.station_id || '|' || s.feed_version_id || '|' ||
      s.source_trip_id || '|' || s.source_stop_id || '|' || s.scheduled_arrival_seconds || '|' ||
      COALESCE(s.selected_delay_seconds::text, '') || '|' || s.evidence_status || '|' ||
      COALESCE(s.evidence_selected_captured_at::text, '') || '|' || COALESCE(s.finalized_at::text, '') || '|' ||
      COALESCE(s.delay_discrepancy_seconds::text, '') || '|' || s.canonical_algorithm_version || '|' || s.revision || '|' || s.repair_version
    FROM core.journey_stop AS s WHERE s.service_date = target_date
  )
  SELECT encode(sha256(convert_to(COALESCE(string_agg(payload, E'\n' ORDER BY payload), ''), 'UTF8')), 'hex')
  FROM source_rows
$function$;

CREATE OR REPLACE FUNCTION operations.canonical_timetable_checksum(target_date date, target_network_id bigint)
RETURNS text
LANGUAGE sql
STABLE
STRICT
PARALLEL SAFE
AS $function$
  SELECT encode(sha256(convert_to(COALESCE(string_agg(
    journey.source_trip_id || ':' || stop.stop_sequence || ':' || stop.source_stop_id || ':' ||
    stop.scheduled_arrival_seconds, E'\n' ORDER BY journey.source_trip_id, stop.stop_sequence
  ), ''), 'UTF8')), 'hex')
  FROM core.journey AS journey
  JOIN core.journey_stop AS stop
    ON stop.service_date = journey.service_date AND stop.journey_id = journey.id
  WHERE journey.service_date = target_date AND journey.network_id = target_network_id
$function$;

CREATE TABLE operations.service_day_quality (
  service_date date PRIMARY KEY,
  poll_count bigint NOT NULL CHECK (poll_count >= 0),
  successful_poll_count bigint NOT NULL CHECK (successful_poll_count >= 0),
  quality_status text NOT NULL CHECK (quality_status IN ('complete', 'incomplete', 'incomplete_acknowledged')),
  acknowledged_at timestamptz,
  acknowledgement_reason text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((quality_status = 'incomplete_acknowledged') =
    (acknowledged_at IS NOT NULL AND btrim(acknowledgement_reason) <> ''))
);

ALTER TABLE operations.month_seal
  ADD COLUMN quality_status text NOT NULL DEFAULT 'complete'
    CHECK (quality_status IN ('complete', 'incomplete_acknowledged')),
  ADD COLUMN incomplete_service_day_count integer NOT NULL DEFAULT 0
    CHECK (incomplete_service_day_count >= 0);

CREATE OR REPLACE FUNCTION operations.acknowledge_incomplete_service_day(
  target_date date, acknowledgement text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, operations
AS $function$
BEGIN
  IF length(btrim(acknowledgement)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Incomplete service-day acknowledgement must be 1 through 200 characters';
  END IF;
  INSERT INTO operations.service_day_quality (
    service_date, poll_count, successful_poll_count, quality_status,
    acknowledged_at, acknowledgement_reason
  ) VALUES (target_date, 0, 0, 'incomplete_acknowledged', clock_timestamp(), acknowledgement)
  ON CONFLICT (service_date) DO UPDATE SET
    quality_status = CASE WHEN operations.service_day_quality.successful_poll_count > 0
      THEN 'complete' ELSE 'incomplete_acknowledged' END,
    acknowledged_at = CASE WHEN operations.service_day_quality.successful_poll_count > 0
      THEN NULL ELSE clock_timestamp() END,
    acknowledgement_reason = CASE WHEN operations.service_day_quality.successful_poll_count > 0
      THEN NULL ELSE EXCLUDED.acknowledgement_reason END,
    updated_at = clock_timestamp();
  RETURN jsonb_build_object('serviceDate', target_date, 'status',
    (SELECT quality_status FROM operations.service_day_quality WHERE service_date = target_date));
END
$function$;

ALTER FUNCTION operations.finalize_service_day(date, text, timestamptz, integer)
  RENAME TO finalize_service_day_from_canonical;

CREATE OR REPLACE FUNCTION operations.finalize_service_day(
  target_date date, algorithm_version text, checked_at timestamptz, grace_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, analytics, operations, core
AS $function$
DECLARE
  expected_journeys bigint;
  expected_stops bigint;
  canonical_journeys bigint;
  canonical_stops bigint;
  last_scheduled_end timestamptz;
  blockers text[] := ARRAY[]::text[];
  item record;
  quality_status_value text;
  finalization_result jsonb;
BEGIN
  SELECT COALESCE(sum(expected_journey_count), 0), COALESCE(sum(expected_stop_count), 0),
    max(last_scheduled_end_at)
  INTO expected_journeys, expected_stops, last_scheduled_end
  FROM operations.expected_service_day WHERE service_date = target_date;
  IF expected_journeys = 0 THEN blockers := array_append(blockers, 'expected_timetable_ledger_missing'); END IF;
  IF last_scheduled_end IS NOT NULL AND last_scheduled_end + make_interval(secs => grace_seconds) > checked_at THEN
    blockers := array_append(blockers, 'service_day_grace_not_elapsed');
  END IF;
  SELECT count(*), (SELECT count(*) FROM core.journey_stop WHERE service_date = target_date)
  INTO canonical_journeys, canonical_stops
  FROM core.journey WHERE service_date = target_date;
  IF canonical_journeys <> expected_journeys THEN blockers := array_append(blockers, 'expected_journey_count_mismatch'); END IF;
  IF canonical_stops <> expected_stops THEN blockers := array_append(blockers, 'expected_stop_count_mismatch'); END IF;
  FOR item IN SELECT * FROM operations.expected_service_day WHERE service_date = target_date LOOP
    IF operations.canonical_timetable_checksum(target_date, item.network_id) IS DISTINCT FROM item.timetable_checksum THEN
      blockers := array_append(blockers, 'expected_timetable_checksum_mismatch');
      EXIT;
    END IF;
  END LOOP;

  INSERT INTO operations.service_day_quality (
    service_date, poll_count, successful_poll_count, quality_status
  ) SELECT target_date, COALESCE(sum(poll_count), 0), COALESCE(sum(successful_poll_count), 0),
      CASE WHEN COALESCE(sum(successful_poll_count), 0) > 0 THEN 'complete' ELSE 'incomplete' END
    FROM operations.daily_feed_coverage WHERE service_date = target_date
  ON CONFLICT (service_date) DO UPDATE SET
    poll_count = EXCLUDED.poll_count, successful_poll_count = EXCLUDED.successful_poll_count,
    quality_status = CASE
      WHEN EXCLUDED.successful_poll_count > 0 THEN 'complete'
      WHEN operations.service_day_quality.quality_status = 'incomplete_acknowledged' THEN 'incomplete_acknowledged'
      ELSE 'incomplete' END,
    acknowledged_at = CASE WHEN EXCLUDED.successful_poll_count > 0 THEN NULL
      ELSE operations.service_day_quality.acknowledged_at END,
    acknowledgement_reason = CASE WHEN EXCLUDED.successful_poll_count > 0 THEN NULL
      ELSE operations.service_day_quality.acknowledgement_reason END,
    updated_at = clock_timestamp();

  SELECT quality_status INTO quality_status_value
  FROM operations.service_day_quality WHERE service_date = target_date;

  IF cardinality(blockers) > 0 THEN
    RETURN jsonb_build_object('serviceDate', target_date, 'status', 'blocked',
      'expectedJourneyCount', expected_journeys, 'expectedStopCount', expected_stops,
      'canonicalJourneyCount', canonical_journeys, 'canonicalStopCount', canonical_stops,
      'qualityStatus', quality_status_value, 'blockers', to_jsonb(blockers));
  END IF;
  finalization_result := operations.finalize_service_day_from_canonical(
    target_date, algorithm_version, checked_at, grace_seconds);
  RETURN finalization_result || jsonb_build_object('qualityStatus', quality_status_value);
END
$function$;

ALTER FUNCTION operations.seal_month(date, text, timestamptz, integer)
  RENAME TO seal_month_from_verified_contributions;

CREATE OR REPLACE FUNCTION operations.seal_month(
  target_month date,
  algorithm_version text,
  checked_at timestamptz,
  grace_hours integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, analytics, operations, core
AS $function$
DECLARE
  month_end date := (target_month + interval '1 month - 1 day')::date;
  expected_days integer;
  verified_days integer;
  blockers text[] := ARRAY[]::text[];
  verification_id_value bigint;
  incomplete_days integer;
  seal_result jsonb;
BEGIN
  IF EXISTS (
    SELECT 1 FROM operations.month_seal
    WHERE calendar_month = target_month
      AND aggregate_algorithm_version = algorithm_version
      AND status = 'sealed'
  ) THEN
    RETURN operations.seal_month_from_verified_contributions(
      target_month, algorithm_version, checked_at, grace_hours
    );
  END IF;
  IF target_month + interval '1 month' + make_interval(hours => grace_hours) > checked_at THEN
    blockers := array_append(blockers, 'month_sealing_grace_not_elapsed');
  END IF;
  IF EXISTS (
    SELECT 1 FROM analytics.dirty_scope
    WHERE service_date >= target_month AND service_date < target_month + interval '1 month'
  ) THEN blockers := array_append(blockers, 'month_contains_dirty_scope'); END IF;
  SELECT count(*) INTO expected_days
  FROM operations.timetable_service_dates(target_month, month_end);
  IF expected_days = 0 THEN blockers := array_append(blockers, 'no_expected_service_days'); END IF;

  SELECT count(*) INTO verified_days
  FROM operations.timetable_service_dates(target_month, month_end) AS expected
  JOIN operations.service_day_finalization AS finalization
    ON finalization.service_date = expected.service_date
   AND finalization.aggregate_algorithm_version = algorithm_version
   AND finalization.status = 'verified';
  IF verified_days <> expected_days THEN
    blockers := array_append(blockers, 'not_all_expected_service_days_verified');
  END IF;
  IF EXISTS (
    SELECT 1
    FROM operations.timetable_service_dates(target_month, month_end) AS expected
    LEFT JOIN operations.service_day_finalization AS finalization
      ON finalization.service_date = expected.service_date
     AND finalization.aggregate_algorithm_version = algorithm_version
     AND finalization.status = 'verified'
    WHERE finalization.service_date IS NULL
       OR finalization.schedule_contribution_checksum IS DISTINCT FROM
          analytics.schedule_contribution_checksum(expected.service_date, algorithm_version)
  ) THEN blockers := array_append(blockers, 'daily_schedule_contribution_checksum_mismatch'); END IF;
  IF EXISTS (
    SELECT 1
    FROM operations.timetable_service_dates(target_month, month_end) AS expected
    LEFT JOIN operations.service_day_quality AS quality ON quality.service_date = expected.service_date
    WHERE quality.quality_status IS NULL OR quality.quality_status = 'incomplete'
  ) THEN blockers := array_append(blockers, 'service_day_quality_unacknowledged'); END IF;

  IF cardinality(blockers) > 0 THEN
    INSERT INTO operations.verification_result (
      scope_kind, calendar_month, aggregate_algorithm_version, passed,
      source_row_count, aggregate_row_count, details
    ) VALUES (
      'month', target_month, algorithm_version, false, expected_days, verified_days,
      jsonb_build_object('blockers', blockers, 'expectedDays', expected_days, 'verifiedDays', verified_days)
    ) RETURNING id INTO verification_id_value;
    RETURN jsonb_build_object(
      'month', target_month, 'status', 'blocked', 'serviceDays', expected_days,
      'verifiedDays', verified_days, 'verificationId', verification_id_value,
      'blockers', to_jsonb(blockers)
    );
  END IF;
  PERFORM set_config('atodotren.sealing_month', target_month::text, true);
  PERFORM set_config('atodotren.sealing_algorithm', algorithm_version, true);
  seal_result := operations.seal_month_from_verified_contributions(
    target_month, algorithm_version, checked_at, grace_hours);
  IF seal_result->>'status' = 'sealed' THEN
    SELECT count(*) INTO incomplete_days
    FROM operations.timetable_service_dates(target_month, month_end) AS expected
    JOIN operations.service_day_quality AS quality ON quality.service_date = expected.service_date
    WHERE quality.quality_status = 'incomplete_acknowledged';
    UPDATE operations.month_seal SET incomplete_service_day_count = incomplete_days,
      quality_status = CASE WHEN incomplete_days > 0 THEN 'incomplete_acknowledged' ELSE 'complete' END
    WHERE calendar_month = target_month AND aggregate_algorithm_version = algorithm_version;
    seal_result := seal_result || jsonb_build_object(
      'qualityStatus', CASE WHEN incomplete_days > 0 THEN 'incomplete_acknowledged' ELSE 'complete' END,
      'incompleteServiceDays', incomplete_days);
  END IF;
  RETURN seal_result;
END
$function$;

ALTER FUNCTION operations.retention_candidates(timestamptz, text)
  RENAME TO retention_candidates_without_evidence_watermark;

CREATE OR REPLACE FUNCTION operations.retention_candidates(as_of timestamptz, algorithm_version text)
RETURNS TABLE(
  family text, target_date date, partition_names text[], expired boolean,
  authorized boolean, blockers text[], source_rows bigint, source_checksum text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, operations, analytics, core, ingest
AS $function$
  SELECT candidate.family, candidate.target_date, candidate.partition_names, candidate.expired,
    candidate.authorized,
    CASE WHEN candidate.family = 'stop_evidence' AND EXISTS (
      SELECT 1
      FROM ingest.stop_evidence AS evidence
      LEFT JOIN core.journey AS journey
        ON journey.service_date = evidence.service_date
       AND journey.feed_version_id = evidence.feed_version_id
       AND journey.source_trip_id = evidence.source_trip_id
       AND journey.start_time IS NOT DISTINCT FROM evidence.start_time
      LEFT JOIN operations.service_day_finalization AS finalization
        ON finalization.service_date = evidence.service_date
       AND finalization.aggregate_algorithm_version = algorithm_version
       AND finalization.status = 'verified'
      WHERE evidence.captured_at >= candidate.target_date::timestamptz
        AND evidence.captured_at < (candidate.target_date + 1)::timestamptz
        AND (
          journey.finalized_at IS NULL
          OR journey.last_evidence_at IS NULL
          OR journey.last_evidence_at < evidence.captured_at
          OR finalization.service_date IS NULL
          OR finalization.source_checksum IS DISTINCT FROM analytics.canonical_source_checksum(evidence.service_date)
        )
    ) THEN array_append(candidate.blockers, 'canonical_evidence_watermark_incomplete')
    ELSE candidate.blockers END,
    candidate.source_rows, candidate.source_checksum
  FROM operations.retention_candidates_without_evidence_watermark(as_of, algorithm_version) AS candidate
$function$;

REVOKE ALL ON analytics.monthly_schedule_classification FROM PUBLIC;
REVOKE ALL ON operations.expected_service_day, operations.calendar_classification,
  operations.service_day_quality FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.timetable_service_dates(date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.expected_timetable_stop(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.materialize_expected_service_day(date, text, timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.canonical_timetable_checksum(date, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.acknowledge_incomplete_service_day(date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.finalize_service_day_from_canonical(date, text, timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.finalize_service_day(date, text, timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.seal_month_from_verified_contributions(date, text, timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.retention_candidates_without_evidence_watermark(timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.seal_month(date, text, timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.retention_candidates(timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION analytics.compact_sealed_schedule_classification() FROM PUBLIC;

-- Renaming the Milestone 4 internals preserves their former grants. Runtime roles
-- must not be able to bypass the guarded wrappers.
REVOKE ALL ON FUNCTION operations.finalize_service_day_from_canonical(date, text, timestamptz, integer)
  FROM atodotren_ingest_writer, atodotren_web_reader, atodotren_backup_reader, atodotren_monitor_reader;
REVOKE ALL ON FUNCTION operations.seal_month_from_verified_contributions(date, text, timestamptz, integer)
  FROM atodotren_ingest_writer, atodotren_web_reader, atodotren_backup_reader, atodotren_monitor_reader;
REVOKE ALL ON FUNCTION operations.retention_candidates_without_evidence_watermark(timestamptz, text)
  FROM atodotren_ingest_writer, atodotren_web_reader, atodotren_backup_reader, atodotren_monitor_reader;
REVOKE ALL ON FUNCTION operations.expected_timetable_stop(date)
  FROM atodotren_ingest_writer, atodotren_web_reader, atodotren_backup_reader, atodotren_monitor_reader;
REVOKE ALL ON FUNCTION operations.canonical_timetable_checksum(date, bigint)
  FROM atodotren_ingest_writer, atodotren_web_reader, atodotren_backup_reader, atodotren_monitor_reader;

GRANT SELECT ON operations.expected_service_day, operations.calendar_classification,
  operations.service_day_quality TO atodotren_ingest_writer;
GRANT SELECT ON analytics.monthly_schedule_classification TO atodotren_ingest_writer;
GRANT SELECT ON operations.expected_service_day, operations.calendar_classification,
  operations.service_day_quality TO atodotren_backup_reader;
GRANT SELECT ON analytics.monthly_schedule_classification TO atodotren_backup_reader;
GRANT EXECUTE ON FUNCTION operations.timetable_service_dates(date, date) TO atodotren_ingest_writer;
GRANT EXECUTE ON FUNCTION operations.materialize_expected_service_day(date, text, timestamptz, integer) TO atodotren_ingest_writer;
GRANT EXECUTE ON FUNCTION operations.acknowledge_incomplete_service_day(date, text) TO atodotren_ingest_writer;
GRANT EXECUTE ON FUNCTION operations.finalize_service_day(date, text, timestamptz, integer) TO atodotren_ingest_writer;
GRANT EXECUTE ON FUNCTION operations.seal_month(date, text, timestamptz, integer) TO atodotren_ingest_writer;
GRANT EXECUTE ON FUNCTION operations.retention_candidates(timestamptz, text) TO atodotren_ingest_writer;
