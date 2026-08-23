-- Ensure finalization verifies the stable dimensions that assign timetable
-- opportunities to public metrics, while permitting equivalent active/previous
-- feed lineage.

SET LOCAL ROLE atodotren_migration_admin;

CREATE OR REPLACE FUNCTION operations.expected_timetable_checksum(
  target_date date,
  target_network_id bigint,
  target_feed_version_id bigint
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, operations
AS $function$
  SELECT encode(sha256(convert_to(COALESCE(string_agg(
    'v2|' || expected.network_id || '|' || expected.source_trip_id || '|' ||
    expected.line_id || '|' || expected.branch_id || '|' || COALESCE(expected.direction::text, '') || '|' ||
    expected.service_pattern_id || '|' || expected.scheduled_start_seconds || '|' ||
    expected.scheduled_end_seconds || '|' || expected.stop_sequence || '|' || expected.station_id || '|' ||
    expected.source_stop_id || '|' || expected.scheduled_arrival_seconds,
    E'\n' ORDER BY expected.source_trip_id, expected.stop_sequence
  ), ''), 'UTF8')), 'hex')
  FROM operations.expected_timetable_stop(target_date) AS expected
  WHERE expected.network_id = target_network_id
    AND expected.feed_version_id = target_feed_version_id
$function$;

CREATE OR REPLACE FUNCTION operations.set_expected_timetable_checksum()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, operations
AS $function$
BEGIN
  NEW.timetable_checksum := operations.expected_timetable_checksum(
    NEW.service_date, NEW.network_id, NEW.feed_version_id
  );
  RETURN NEW;
END
$function$;

CREATE TRIGGER expected_service_day_metric_checksum
BEFORE INSERT OR UPDATE ON operations.expected_service_day
FOR EACH ROW EXECUTE FUNCTION operations.set_expected_timetable_checksum();

CREATE OR REPLACE FUNCTION operations.canonical_timetable_checksum(
  target_date date,
  target_network_id bigint
)
RETURNS text
LANGUAGE sql
STABLE
STRICT
PARALLEL SAFE
AS $function$
  SELECT encode(sha256(convert_to(COALESCE(string_agg(
    'v2|' || journey.network_id || '|' || journey.source_trip_id || '|' ||
    journey.line_id || '|' || journey.branch_id || '|' || COALESCE(journey.direction::text, '') || '|' ||
    journey.service_pattern_id || '|' || journey.scheduled_start_seconds || '|' ||
    journey.scheduled_end_seconds || '|' || stop.stop_sequence || '|' || stop.station_id || '|' ||
    stop.source_stop_id || '|' || stop.scheduled_arrival_seconds,
    E'\n' ORDER BY journey.source_trip_id, stop.stop_sequence
  ), ''), 'UTF8')), 'hex')
  FROM core.journey AS journey
  JOIN core.journey_stop AS stop
    ON stop.service_date = journey.service_date AND stop.journey_id = journey.id
  WHERE journey.service_date = target_date AND journey.network_id = target_network_id
$function$;

REVOKE ALL ON FUNCTION operations.expected_timetable_checksum(date, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.set_expected_timetable_checksum() FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.canonical_timetable_checksum(date, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.expected_timetable_checksum(date, bigint, bigint)
  FROM atodotren_ingest_writer, atodotren_web_reader, atodotren_backup_reader, atodotren_monitor_reader;
REVOKE ALL ON FUNCTION operations.set_expected_timetable_checksum()
  FROM atodotren_ingest_writer, atodotren_web_reader, atodotren_backup_reader, atodotren_monitor_reader;
REVOKE ALL ON FUNCTION operations.canonical_timetable_checksum(date, bigint)
  FROM atodotren_ingest_writer, atodotren_web_reader, atodotren_backup_reader, atodotren_monitor_reader;
