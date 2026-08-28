-- Live station metrics: expose the last observed stop for upcoming trains and current-day accumulated delay at a station.
-- Existing accepted migrations remain immutable; this migration only extends the public web read model.

SET LOCAL ROLE atodotren_migration_admin;

DROP FUNCTION IF EXISTS api.recent_station_calls(text, date, integer);

CREATE OR REPLACE VIEW api.upcoming_station_live_vehicle
WITH (security_barrier = true)
AS
WITH latest_vehicle_poll AS (
  SELECT poll.captured_at
  FROM ingest.poll_run AS poll
  WHERE poll.feed_kind = 'vehicle_positions'
    AND poll.result_class = 'success'
  ORDER BY poll.captured_at DESC, poll.id DESC
  LIMIT 1
)
SELECT
  vehicle.*,
  target_station.public_id AS target_station_id,
  target_station.slug_es AS target_station_slug_es,
  target_station.slug_en AS target_station_slug_en,
  target_station.name_es AS target_station_name_es,
  target_station.name_en AS target_station_name_en,
  target_stop.stop_sequence AS target_stop_sequence,
  target_stop.scheduled_arrival_at AS station_scheduled_arrival_at,
  target_stop.scheduled_arrival_at
    + make_interval(secs => COALESCE(vehicle.latest_usable_delay, vehicle.latest_stop_delay, 0))
      AS station_expected_arrival_at,
  last_stopped.station_id AS last_stopped_station_id,
  last_stopped.station_slug_es AS last_stopped_station_slug_es,
  last_stopped.station_slug_en AS last_stopped_station_slug_en,
  last_stopped.station_name_es AS last_stopped_station_name_es,
  last_stopped.station_name_en AS last_stopped_station_name_en
FROM api.active_live_vehicle AS vehicle
JOIN latest_vehicle_poll AS latest_poll
  ON latest_poll.captured_at = vehicle.captured_at
JOIN core.journey_stop AS target_stop
  ON target_stop.service_date = vehicle.service_date
  AND target_stop.journey_id = vehicle.journey_id
JOIN core.station AS target_station
  ON target_station.id = target_stop.station_id
LEFT JOIN LATERAL (
  SELECT
    station.public_id AS station_id,
    station.slug_es AS station_slug_es,
    station.slug_en AS station_slug_en,
    station.name_es AS station_name_es,
    station.name_en AS station_name_en
  FROM core.journey_stop AS stop
  JOIN core.station AS station ON station.id = stop.station_id
  WHERE stop.service_date = vehicle.service_date
    AND stop.journey_id = vehicle.journey_id
    AND stop.first_stopped_presence_at IS NOT NULL
    AND stop.first_stopped_presence_at <= clock_timestamp()
    AND stop.stop_sequence <= vehicle.current_stop_sequence
  ORDER BY stop.stop_sequence DESC, stop.first_stopped_presence_at DESC
  LIMIT 1
) AS last_stopped ON true
WHERE vehicle.current_stop_sequence IS NOT NULL
  AND target_stop.scheduled_arrival_at IS NOT NULL
  AND target_stop.evidence_status NOT IN ('skipped', 'canceled')
  AND (
    (vehicle.current_status = 'STOPPED_AT' AND target_stop.stop_sequence > vehicle.current_stop_sequence)
    OR (
      vehicle.current_status IN ('INCOMING_AT', 'IN_TRANSIT_TO', 'UNKNOWN')
      AND target_stop.stop_sequence >= vehicle.current_stop_sequence
    )
  );

REVOKE ALL ON api.upcoming_station_live_vehicle FROM PUBLIC;
GRANT SELECT ON api.upcoming_station_live_vehicle TO atodotren_web_reader;

CREATE OR REPLACE FUNCTION api.station_live_day_metrics(
  requested_station_id text,
  requested_service_date date,
  requested_at timestamptz DEFAULT clock_timestamp()
)
RETURNS TABLE (
  total_added_delay_seconds bigint,
  usable_stop_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, core
AS $function$
DECLARE
  madrid_today date := (requested_at AT TIME ZONE 'Europe/Madrid')::date;
BEGIN
  IF requested_station_id IS NULL OR btrim(requested_station_id) = '' THEN
    RAISE EXCEPTION 'Station id is required';
  END IF;
  IF requested_service_date IS NULL
    OR requested_service_date < madrid_today - 30
    OR requested_service_date > madrid_today
  THEN
    RAISE EXCEPTION 'Requested station metric date is outside the 30-day detailed-data window';
  END IF;

  RETURN QUERY
  SELECT
    COALESCE(sum(greatest(stop.selected_delay_seconds, 0)::bigint), 0)::bigint,
    count(*)::bigint
  FROM core.journey_stop AS stop
  JOIN core.journey AS journey
    ON journey.service_date = stop.service_date AND journey.id = stop.journey_id
  JOIN core.station AS station ON station.id = stop.station_id
  JOIN core.network AS network ON network.id = journey.network_id
  WHERE stop.service_date = requested_service_date
    AND station.public_id = requested_station_id
    AND network.slug = 'madrid'
    AND stop.first_stopped_presence_at IS NOT NULL
    AND stop.first_stopped_presence_at <= requested_at
    AND stop.selected_delay_seconds IS NOT NULL
    AND stop.evidence_status IN ('reported_only', 'observed_presence')
    AND stop.evidence_selected_captured_at IS NOT NULL
    AND stop.evidence_selected_captured_at <= requested_at;
END
$function$;

REVOKE ALL ON FUNCTION api.station_live_day_metrics(text, date, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.station_live_day_metrics(text, date, timestamptz) TO atodotren_web_reader;
