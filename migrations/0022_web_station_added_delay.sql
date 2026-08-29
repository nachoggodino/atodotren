-- Station-added delay: measure the signed delay delta between a station call and its immediately previous stop.
-- Existing migrations are immutable; this migration only corrects the public live-station metric semantics.

SET LOCAL ROLE atodotren_migration_admin;

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
  WITH station_calls AS (
    SELECT
      stop.service_date,
      stop.journey_id,
      stop.stop_sequence,
      stop.selected_delay_seconds
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
      AND stop.evidence_selected_captured_at <= requested_at
  ),
  station_deltas AS (
    SELECT
      station_call.selected_delay_seconds - previous_stop.selected_delay_seconds AS added_delay_seconds
    FROM station_calls AS station_call
    JOIN LATERAL (
      SELECT
        previous.selected_delay_seconds,
        previous.first_stopped_presence_at,
        previous.evidence_status,
        previous.evidence_selected_captured_at
      FROM core.journey_stop AS previous
      WHERE previous.service_date = station_call.service_date
        AND previous.journey_id = station_call.journey_id
        AND previous.stop_sequence < station_call.stop_sequence
      ORDER BY previous.stop_sequence DESC
      LIMIT 1
    ) AS previous_stop ON true
    WHERE previous_stop.first_stopped_presence_at IS NOT NULL
      AND previous_stop.first_stopped_presence_at <= requested_at
      AND previous_stop.selected_delay_seconds IS NOT NULL
      AND previous_stop.evidence_status IN ('reported_only', 'observed_presence')
      AND previous_stop.evidence_selected_captured_at IS NOT NULL
      AND previous_stop.evidence_selected_captured_at <= requested_at
  )
  SELECT
    COALESCE(sum(station_deltas.added_delay_seconds::bigint), 0)::bigint,
    count(*)::bigint
  FROM station_deltas;
END
$function$;

REVOKE ALL ON FUNCTION api.station_live_day_metrics(text, date, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.station_live_day_metrics(text, date, timestamptz) TO atodotren_web_reader;
