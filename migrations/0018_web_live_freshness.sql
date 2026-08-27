-- Frontend corrections: authoritative live freshness, enriched train reads and journey-delay semantics.
-- Existing migrations remain immutable; this migration only changes the public web read model.

SET LOCAL ROLE atodotren_migration_admin;

CREATE OR REPLACE FUNCTION api.live_vehicle_is_active(
  vehicle_service_date date,
  vehicle_captured_at timestamptz,
  vehicle_timestamp bigint,
  network_timezone text,
  requested_at timestamptz DEFAULT clock_timestamp()
)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $function$
  SELECT
    vehicle_service_date = (requested_at AT TIME ZONE network_timezone)::date
    AND vehicle_captured_at >= requested_at - interval '120 seconds'
    AND vehicle_captured_at <= requested_at + interval '30 seconds'
    AND (
      vehicle_timestamp IS NULL
      OR (
        to_timestamp(vehicle_timestamp) >= requested_at - interval '120 seconds'
        AND to_timestamp(vehicle_timestamp) <= requested_at + interval '30 seconds'
      )
    )
$function$;

CREATE OR REPLACE VIEW api.active_live_vehicle
WITH (security_barrier = true)
AS
SELECT
  network.slug AS network_slug,
  state.state_key,
  state.captured_at,
  state.service_date,
  state.source_trip_id,
  state.vehicle_id,
  line.slug AS line_slug,
  line.public_code,
  line.name_es AS line_name_es,
  line.name_en AS line_name_en,
  state.current_stop_sequence,
  current_station.public_id AS current_station_id,
  current_station.slug_es AS current_station_slug_es,
  current_station.slug_en AS current_station_slug_en,
  current_station.name_es AS current_station_name_es,
  current_station.name_en AS current_station_name_en,
  state.current_status,
  state.latest_stop_delay,
  state.vehicle_timestamp,
  journey.id AS journey_id,
  pattern.public_id AS pattern_id,
  COALESCE(journey.direction, pattern.direction) AS direction,
  static_trip.trip_headsign AS headsign,
  to_timestamp(state.vehicle_timestamp) AS vehicle_source_at,
  previous_station.public_id AS previous_station_id,
  previous_station.slug_es AS previous_station_slug_es,
  previous_station.slug_en AS previous_station_slug_en,
  previous_station.name_es AS previous_station_name_es,
  previous_station.name_en AS previous_station_name_en,
  next_station.public_id AS next_station_id,
  next_station.slug_es AS next_station_slug_es,
  next_station.slug_en AS next_station_slug_en,
  next_station.name_es AS next_station_name_es,
  next_station.name_en AS next_station_name_en,
  origin_station.public_id AS origin_station_id,
  origin_station.slug_es AS origin_station_slug_es,
  origin_station.slug_en AS origin_station_slug_en,
  origin_station.name_es AS origin_station_name_es,
  origin_station.name_en AS origin_station_name_en,
  destination_station.public_id AS destination_station_id,
  destination_station.slug_es AS destination_station_slug_es,
  destination_station.slug_en AS destination_station_slug_en,
  destination_station.name_es AS destination_station_name_es,
  destination_station.name_en AS destination_station_name_en,
  next_stop.scheduled_arrival_at AS scheduled_next_arrival_at,
  next_stop.renfe_arrival_at AS reported_next_arrival_at,
  previous_stop.renfe_arrival_at AS previous_reported_arrival_at,
  previous_stop.first_stopped_presence_at AS previous_observed_presence_at,
  latest_delay.selected_delay_seconds AS latest_usable_delay,
  latest_delay.evidence_selected_captured_at AS latest_delay_source_at
FROM ingest.live_vehicle_state AS state
JOIN core.line AS line ON line.id = state.line_id
JOIN core.network AS network ON network.id = line.network_id
JOIN core.service_pattern AS pattern ON pattern.id = state.service_pattern_id
LEFT JOIN core.station AS current_station ON current_station.id = state.current_station_id
LEFT JOIN core.journey AS journey
  ON journey.service_date = state.service_date
  AND journey.feed_version_id = state.feed_version_id
  AND journey.source_trip_id = state.source_trip_id
  AND journey.start_time IS NOT DISTINCT FROM state.start_time
LEFT JOIN gtfs_static.trip AS static_trip
  ON static_trip.feed_version_id = state.feed_version_id
  AND static_trip.trip_id = state.source_trip_id
LEFT JOIN LATERAL (
  SELECT stop.*
  FROM core.journey_stop AS stop
  WHERE journey.id IS NOT NULL
    AND stop.service_date = journey.service_date
    AND stop.journey_id = journey.id
    AND state.current_stop_sequence IS NOT NULL
    AND stop.stop_sequence < state.current_stop_sequence
  ORDER BY stop.stop_sequence DESC
  LIMIT 1
) AS previous_stop ON true
LEFT JOIN core.station AS previous_station ON previous_station.id = previous_stop.station_id
LEFT JOIN LATERAL (
  SELECT stop.*
  FROM core.journey_stop AS stop
  WHERE journey.id IS NOT NULL
    AND stop.service_date = journey.service_date
    AND stop.journey_id = journey.id
    AND state.current_stop_sequence IS NOT NULL
    AND (
      (state.current_status = 'STOPPED_AT' AND stop.stop_sequence > state.current_stop_sequence)
      OR (state.current_status IN ('INCOMING_AT', 'IN_TRANSIT_TO') AND stop.stop_sequence >= state.current_stop_sequence)
    )
  ORDER BY stop.stop_sequence
  LIMIT 1
) AS next_stop ON true
LEFT JOIN core.station AS next_station ON next_station.id = next_stop.station_id
LEFT JOIN LATERAL (
  SELECT stop.station_id
  FROM core.journey_stop AS stop
  WHERE journey.id IS NOT NULL
    AND stop.service_date = journey.service_date
    AND stop.journey_id = journey.id
  ORDER BY stop.stop_sequence
  LIMIT 1
) AS origin_stop ON true
LEFT JOIN core.station AS origin_station ON origin_station.id = origin_stop.station_id
LEFT JOIN LATERAL (
  SELECT stop.station_id
  FROM core.journey_stop AS stop
  WHERE journey.id IS NOT NULL
    AND stop.service_date = journey.service_date
    AND stop.journey_id = journey.id
  ORDER BY stop.stop_sequence DESC
  LIMIT 1
) AS destination_stop ON true
LEFT JOIN core.station AS destination_station ON destination_station.id = destination_stop.station_id
LEFT JOIN LATERAL (
  SELECT stop.selected_delay_seconds, stop.evidence_selected_captured_at
  FROM core.journey_stop AS stop
  WHERE journey.id IS NOT NULL
    AND stop.service_date = journey.service_date
    AND stop.journey_id = journey.id
    AND stop.selected_delay_seconds IS NOT NULL
    AND stop.evidence_status IN ('reported_only', 'observed_presence')
    AND stop.evidence_selected_captured_at IS NOT NULL
  ORDER BY stop.evidence_selected_captured_at DESC, stop.stop_sequence DESC
  LIMIT 1
) AS latest_delay ON true
WHERE api.live_vehicle_is_active(
  state.service_date,
  state.captured_at,
  state.vehicle_timestamp,
  network.timezone,
  clock_timestamp()
);

DROP FUNCTION api.landing_delay_timeline(text, timestamptz);

CREATE FUNCTION api.landing_delay_timeline(
  requested_network_slug text,
  requested_at timestamptz DEFAULT clock_timestamp()
)
RETURNS TABLE (
  bucket_at timestamptz,
  accumulated_journey_delay_seconds bigint,
  current_accumulated_journey_delay_seconds bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, api, core
AS $function$
  WITH network_context AS (
    SELECT network.id, network.timezone,
      (requested_at AT TIME ZONE network.timezone)::date AS service_date
    FROM core.network AS network
    WHERE network.slug = requested_network_slug AND network.is_active
  ), window_bounds AS (
    SELECT context.service_date,
      (context.service_date::timestamp + interval '05:00') AT TIME ZONE context.timezone AS starts_at,
      ((context.service_date + 1)::timestamp + interval '02:00') AT TIME ZONE context.timezone AS ends_at
    FROM network_context AS context
  ), usable_evidence AS (
    SELECT
      stop.journey_id,
      stop.stop_sequence,
      greatest(stop.selected_delay_seconds, 0)::bigint AS contribution_seconds,
      stop.evidence_selected_captured_at AS observed_at
    FROM core.journey_stop AS stop
    JOIN core.journey AS journey
      ON journey.service_date = stop.service_date AND journey.id = stop.journey_id
    JOIN network_context AS context
      ON context.id = journey.network_id AND context.service_date = stop.service_date
    WHERE stop.evidence_status IN ('reported_only', 'observed_presence')
      AND stop.selected_delay_seconds IS NOT NULL
      AND stop.evidence_selected_captured_at IS NOT NULL
      AND stop.evidence_selected_captured_at <= requested_at
  ), evidence_intervals AS (
    SELECT
      evidence.journey_id,
      evidence.contribution_seconds,
      evidence.observed_at,
      lead(evidence.observed_at) OVER (
        PARTITION BY evidence.journey_id
        ORDER BY evidence.observed_at, evidence.stop_sequence
      ) AS replaced_at
    FROM usable_evidence AS evidence
  ), current_total AS (
    SELECT COALESCE(sum(latest.contribution_seconds), 0)::bigint AS total
    FROM (
      SELECT DISTINCT ON (journey_id) journey_id, contribution_seconds
      FROM usable_evidence
      ORDER BY journey_id, observed_at DESC, stop_sequence DESC
    ) AS latest
  ), buckets AS (
    SELECT generate_series(bounds.starts_at, bounds.ends_at, interval '30 minutes') AS bucket_at
    FROM window_bounds AS bounds
  )
  SELECT
    buckets.bucket_at,
    CASE WHEN buckets.bucket_at > requested_at THEN NULL::bigint
      ELSE COALESCE(sum(interval.contribution_seconds), 0)::bigint END AS accumulated_journey_delay_seconds,
    current_total.total AS current_accumulated_journey_delay_seconds
  FROM buckets
  CROSS JOIN current_total
  LEFT JOIN evidence_intervals AS interval
    ON interval.observed_at <= buckets.bucket_at
    AND (interval.replaced_at IS NULL OR interval.replaced_at > buckets.bucket_at)
  GROUP BY buckets.bucket_at, current_total.total
  ORDER BY buckets.bucket_at
$function$;

REVOKE ALL ON FUNCTION api.live_vehicle_is_active(date, timestamptz, bigint, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.live_vehicle_is_active(date, timestamptz, bigint, text, timestamptz) FROM atodotren_web_reader;
REVOKE ALL ON FUNCTION api.landing_delay_timeline(text, timestamptz) FROM PUBLIC;
GRANT SELECT ON api.active_live_vehicle TO atodotren_web_reader;
GRANT EXECUTE ON FUNCTION api.landing_delay_timeline(text, timestamptz) TO atodotren_web_reader;
