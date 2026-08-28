-- Live station cadence: expose a bounded current-day stop-call sequence for server-side regularity analysis.
-- Existing migrations are immutable; this migration extends the public web read model only.

SET LOCAL ROLE atodotren_migration_admin;

CREATE OR REPLACE FUNCTION api.recent_station_calls(
  requested_station_id text,
  requested_service_date date,
  row_limit integer DEFAULT 4000
)
RETURNS TABLE (
  line_slug text,
  direction smallint,
  scheduled_arrival_at timestamptz,
  selected_delay_seconds integer,
  evidence_status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, core
AS $function$
DECLARE
  bounded_limit integer := greatest(1, least(COALESCE(row_limit, 4000), 6000));
  madrid_today date := (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Madrid')::date;
BEGIN
  IF requested_station_id IS NULL OR btrim(requested_station_id) = '' THEN
    RAISE EXCEPTION 'Station id is required';
  END IF;
  IF requested_service_date IS NULL
    OR requested_service_date < madrid_today - 30
    OR requested_service_date > madrid_today
  THEN
    RAISE EXCEPTION 'Requested station-call date is outside the 30-day detailed-data window';
  END IF;

  RETURN QUERY
  SELECT
    line.slug,
    journey.direction,
    stop.scheduled_arrival_at,
    stop.selected_delay_seconds,
    stop.evidence_status
  FROM core.journey_stop AS stop
  JOIN core.journey AS journey
    ON journey.service_date = stop.service_date AND journey.id = stop.journey_id
  JOIN core.line AS line ON line.id = journey.line_id
  JOIN core.station AS station ON station.id = stop.station_id
  JOIN core.network AS network ON network.id = journey.network_id
  WHERE stop.service_date = requested_service_date
    AND station.public_id = requested_station_id
    AND network.slug = 'madrid'
    AND journey.direction IS NOT NULL
  ORDER BY stop.scheduled_arrival_at, line.slug, journey.direction, journey.id
  LIMIT bounded_limit;
END
$function$;

REVOKE ALL ON FUNCTION api.recent_station_calls(text, date, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.recent_station_calls(text, date, integer) TO atodotren_web_reader;
