-- Frontend alpha: bounded public read models for the Next.js server.
-- Migrations 0001-0012 are immutable. Browser clients never receive database credentials.

SET LOCAL ROLE atodotren_migration_admin;

CREATE OR REPLACE FUNCTION api.normalize_search(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $function$
  SELECT btrim(regexp_replace(
    translate(lower(value),
      'áàäâãåéèëêíìïîóòöôõúùüûñç',
      'aaaaaaeeeeiiiiooooouuuunc'),
    '[^a-z0-9]+', ' ', 'g'
  ))
$function$;

CREATE OR REPLACE VIEW api.line_catalog
WITH (security_barrier = true)
AS
SELECT
  network.slug AS network_slug,
  line.id AS line_id,
  line.slug,
  line.public_code,
  line.name_es,
  line.name_en,
  line.color,
  line.text_color,
  line.display_order
FROM core.line AS line
JOIN core.network AS network ON network.id = line.network_id
WHERE network.is_active AND line.is_active;

CREATE OR REPLACE VIEW api.station_catalog
WITH (security_barrier = true)
AS
SELECT
  network.slug AS network_slug,
  station.id AS station_id,
  station.public_id,
  station.slug_es,
  station.slug_en,
  station.name_es,
  station.name_en
FROM core.station AS station
JOIN core.network AS network ON network.id = station.network_id
WHERE network.is_active AND station.is_active;

CREATE OR REPLACE VIEW api.live_vehicle
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
  station.public_id AS current_station_id,
  station.slug_es AS current_station_slug_es,
  station.slug_en AS current_station_slug_en,
  station.name_es AS current_station_name_es,
  station.name_en AS current_station_name_en,
  state.current_status,
  state.latest_stop_delay,
  state.vehicle_timestamp
FROM ingest.live_vehicle_state AS state
JOIN core.line AS line ON line.id = state.line_id
JOIN core.network AS network ON network.id = line.network_id
LEFT JOIN core.station AS station ON station.id = state.current_station_id;

CREATE OR REPLACE VIEW api.schematic_pattern_stop
WITH (security_barrier = true)
AS
SELECT
  network.slug AS network_slug,
  line.slug AS line_slug,
  line.public_code,
  branch.slug AS branch_slug,
  pattern.public_id AS pattern_id,
  pattern.direction,
  pattern_stop.stop_order,
  station.public_id AS station_id,
  station.slug_es AS station_slug_es,
  station.slug_en AS station_slug_en,
  station.name_es AS station_name_es,
  station.name_en AS station_name_en
FROM core.service_pattern_stop AS pattern_stop
JOIN core.service_pattern AS pattern ON pattern.id = pattern_stop.service_pattern_id
JOIN core.branch AS branch ON branch.id = pattern.branch_id
JOIN core.line AS line ON line.id = branch.line_id
JOIN core.network AS network ON network.id = line.network_id
JOIN core.station AS station ON station.id = pattern_stop.station_id
WHERE network.is_active AND line.is_active AND branch.is_active AND pattern.is_active AND station.is_active;

CREATE OR REPLACE VIEW api.history_network_day
WITH (security_barrier = true)
AS
SELECT
  network.slug AS network_slug,
  summary.service_date,
  summary.scheduled_opportunities,
  summary.valid_delay_observations,
  summary.punctual_count,
  summary.early_count,
  summary.zero_to_two_count,
  summary.over_two_to_five_count,
  summary.over_five_to_ten_count,
  summary.over_ten_to_fifteen_count,
  summary.over_fifteen_count,
  summary.canceled_count,
  summary.skipped_count,
  summary.missing_evidence_count,
  summary.pending_count,
  summary.reported_only_count,
  summary.observed_presence_count,
  summary.signed_delay_sum,
  summary.minimum_delay_seconds,
  summary.maximum_delay_seconds,
  summary.delay_histogram,
  summary.source_coverage,
  summary.aggregate_algorithm_version
FROM analytics.daily_network_summary AS summary
JOIN core.network AS network ON network.id = summary.network_id;

CREATE OR REPLACE VIEW api.history_line_day
WITH (security_barrier = true)
AS
SELECT
  network.slug AS network_slug,
  line.slug AS line_slug,
  line.public_code,
  line.name_es,
  line.name_en,
  summary.service_date,
  summary.scheduled_opportunities,
  summary.valid_delay_observations,
  summary.punctual_count,
  summary.early_count,
  summary.zero_to_two_count,
  summary.over_two_to_five_count,
  summary.over_five_to_ten_count,
  summary.over_ten_to_fifteen_count,
  summary.over_fifteen_count,
  summary.canceled_count,
  summary.skipped_count,
  summary.missing_evidence_count,
  summary.pending_count,
  summary.reported_only_count,
  summary.observed_presence_count,
  summary.signed_delay_sum,
  summary.minimum_delay_seconds,
  summary.maximum_delay_seconds,
  summary.delay_histogram,
  summary.source_coverage,
  summary.aggregate_algorithm_version
FROM analytics.daily_line_summary AS summary
JOIN core.line AS line ON line.id = summary.line_id
JOIN core.network AS network ON network.id = summary.network_id;

CREATE OR REPLACE VIEW api.history_line_hour
WITH (security_barrier = true)
AS
SELECT
  network.slug AS network_slug,
  line.slug AS line_slug,
  aggregate.service_date,
  aggregate.direction,
  aggregate.scheduled_hour,
  sum(aggregate.scheduled_opportunities)::bigint AS scheduled_opportunities,
  sum(aggregate.valid_delay_observations)::bigint AS valid_delay_observations,
  sum(aggregate.punctual_count)::bigint AS punctual_count,
  sum(aggregate.signed_delay_sum)::bigint AS signed_delay_sum,
  analytics.histogram_sum(aggregate.delay_histogram) AS delay_histogram,
  min(aggregate.source_coverage) AS source_coverage,
  min(aggregate.aggregate_algorithm_version) AS aggregate_algorithm_version,
  max(aggregate.aggregate_algorithm_version) AS aggregate_algorithm_version_max
FROM analytics.daily_stop_call_hour AS aggregate
JOIN core.line AS line ON line.id = aggregate.line_id
JOIN core.network AS network ON network.id = aggregate.network_id
GROUP BY network.slug, line.slug, aggregate.service_date, aggregate.direction, aggregate.scheduled_hour;

CREATE OR REPLACE VIEW api.history_station_hour
WITH (security_barrier = true)
AS
SELECT
  network.slug AS network_slug,
  station.public_id AS station_id,
  station.slug_es AS station_slug_es,
  station.slug_en AS station_slug_en,
  aggregate.service_date,
  aggregate.line_id,
  line.slug AS line_slug,
  aggregate.direction,
  aggregate.scheduled_hour,
  sum(aggregate.scheduled_opportunities)::bigint AS scheduled_opportunities,
  sum(aggregate.valid_delay_observations)::bigint AS valid_delay_observations,
  sum(aggregate.punctual_count)::bigint AS punctual_count,
  sum(aggregate.canceled_count)::bigint AS canceled_count,
  sum(aggregate.missing_evidence_count)::bigint AS missing_evidence_count,
  sum(aggregate.signed_delay_sum)::bigint AS signed_delay_sum,
  analytics.histogram_sum(aggregate.delay_histogram) AS delay_histogram,
  min(aggregate.source_coverage) AS source_coverage,
  min(aggregate.aggregate_algorithm_version) AS aggregate_algorithm_version,
  max(aggregate.aggregate_algorithm_version) AS aggregate_algorithm_version_max
FROM analytics.daily_stop_call_hour AS aggregate
JOIN core.station AS station ON station.id = aggregate.station_id
JOIN core.line AS line ON line.id = aggregate.line_id
JOIN core.network AS network ON network.id = aggregate.network_id
GROUP BY network.slug, station.public_id, station.slug_es, station.slug_en,
  aggregate.service_date, aggregate.line_id, line.slug, aggregate.direction, aggregate.scheduled_hour;

CREATE OR REPLACE VIEW api.service_day_state
WITH (security_barrier = true)
AS
SELECT
  finalization.service_date,
  finalization.aggregate_algorithm_version,
  finalization.status,
  finalization.finalized_at,
  coverage.feed_kind,
  coverage.poll_count,
  coverage.successful_poll_count,
  coverage.first_poll_at,
  coverage.last_poll_at
FROM operations.service_day_finalization AS finalization
LEFT JOIN operations.daily_feed_coverage AS coverage
  ON coverage.service_date = finalization.service_date;

CREATE OR REPLACE FUNCTION api.catalog_search(search_term text, result_limit integer DEFAULT 12)
RETURNS TABLE (
  entity_kind text,
  stable_id text,
  slug_es text,
  slug_en text,
  public_code text,
  name_es text,
  name_en text,
  score integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, api, core
AS $function$
  WITH input AS (
    SELECT api.normalize_search(search_term) AS term,
      greatest(1, least(COALESCE(result_limit, 12), 20)) AS max_results
  ), candidates AS (
    SELECT 'line'::text AS entity_kind,
      line.slug AS stable_id,
      line.slug AS slug_es,
      line.slug AS slug_en,
      line.public_code,
      line.name_es,
      line.name_en,
      CASE
        WHEN api.normalize_search(line.public_code) = input.term THEN 100
        WHEN api.normalize_search(line.slug) = input.term THEN 95
        WHEN api.normalize_search(line.name_es) = input.term OR api.normalize_search(line.name_en) = input.term THEN 90
        WHEN api.normalize_search(line.public_code) LIKE input.term || '%' THEN 80
        ELSE 60
      END AS score
    FROM core.line AS line
    JOIN core.network AS network ON network.id = line.network_id
    CROSS JOIN input
    WHERE network.slug = 'madrid' AND network.is_active AND line.is_active
      AND input.term <> ''
      AND concat_ws(' ', api.normalize_search(line.public_code), api.normalize_search(line.slug),
        api.normalize_search(line.name_es), api.normalize_search(line.name_en)) LIKE '%' || input.term || '%'
    UNION ALL
    SELECT 'station'::text,
      station.public_id,
      station.slug_es,
      station.slug_en,
      NULL::text,
      station.name_es,
      station.name_en,
      CASE
        WHEN api.normalize_search(station.public_id) = input.term THEN 100
        WHEN api.normalize_search(station.slug_es) = input.term OR api.normalize_search(station.slug_en) = input.term THEN 95
        WHEN api.normalize_search(station.name_es) = input.term OR api.normalize_search(station.name_en) = input.term THEN 90
        WHEN api.normalize_search(station.name_es) LIKE input.term || '%' OR api.normalize_search(station.name_en) LIKE input.term || '%' THEN 80
        ELSE 60
      END
    FROM core.station AS station
    JOIN core.network AS network ON network.id = station.network_id
    CROSS JOIN input
    WHERE network.slug = 'madrid' AND network.is_active AND station.is_active
      AND input.term <> ''
      AND concat_ws(' ', api.normalize_search(station.public_id), api.normalize_search(station.slug_es),
        api.normalize_search(station.slug_en), api.normalize_search(station.name_es), api.normalize_search(station.name_en)) LIKE '%' || input.term || '%'
  )
  SELECT candidates.*
  FROM candidates CROSS JOIN input
  ORDER BY candidates.score DESC, candidates.entity_kind, candidates.name_es
  LIMIT (SELECT max_results FROM input)
$function$;

CREATE OR REPLACE FUNCTION api.recent_line_matrix(requested_line_slug text, requested_service_date date, row_limit integer DEFAULT 4000)
RETURNS TABLE (
  service_date date,
  journey_id bigint,
  source_trip_id text,
  direction smallint,
  lifecycle_status text,
  stop_sequence integer,
  station_id text,
  station_slug_es text,
  station_slug_en text,
  station_name_es text,
  station_name_en text,
  scheduled_arrival_at timestamptz,
  renfe_arrival_at timestamptz,
  selected_delay_seconds integer,
  evidence_status text,
  evidence_selected_captured_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, core
AS $function$
DECLARE
  bounded_limit integer := greatest(1, least(COALESCE(row_limit, 4000), 6000));
BEGIN
  IF requested_service_date IS NULL
    OR requested_service_date < current_date - 30
    OR requested_service_date > current_date
  THEN
    RAISE EXCEPTION 'Requested matrix date is outside the 30-day detailed-data window';
  END IF;
  RETURN QUERY
  SELECT
    journey.service_date,
    journey.id,
    journey.source_trip_id,
    journey.direction,
    journey.lifecycle_status,
    stop.stop_sequence,
    station.public_id,
    station.slug_es,
    station.slug_en,
    station.name_es,
    station.name_en,
    stop.scheduled_arrival_at,
    stop.renfe_arrival_at,
    stop.selected_delay_seconds,
    stop.evidence_status,
    stop.evidence_selected_captured_at
  FROM core.journey AS journey
  JOIN core.line AS line ON line.id = journey.line_id
  JOIN core.journey_stop AS stop
    ON stop.service_date = journey.service_date AND stop.journey_id = journey.id
  JOIN core.station AS station ON station.id = stop.station_id
  WHERE journey.service_date = requested_service_date AND line.slug = requested_line_slug
  ORDER BY journey.scheduled_start_at, journey.id, stop.stop_sequence
  LIMIT bounded_limit;
END
$function$;

CREATE OR REPLACE FUNCTION api.recent_journey(requested_service_date date, requested_journey_id bigint)
RETURNS TABLE (
  service_date date,
  journey_id bigint,
  source_trip_id text,
  line_slug text,
  public_code text,
  direction smallint,
  lifecycle_status text,
  scheduled_start_at timestamptz,
  scheduled_end_at timestamptz,
  stop_sequence integer,
  station_id text,
  station_name_es text,
  station_name_en text,
  scheduled_arrival_at timestamptz,
  renfe_arrival_at timestamptz,
  renfe_arrival_delay_seconds integer,
  derived_delay_seconds integer,
  selected_delay_seconds integer,
  selected_delay_source text,
  first_stopped_presence_at timestamptz,
  evidence_status text,
  evidence_selected_captured_at timestamptz,
  canonical_algorithm_version text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, core
AS $function$
BEGIN
  IF requested_service_date IS NULL
    OR requested_service_date < current_date - 30
    OR requested_service_date > current_date
  THEN
    RAISE EXCEPTION 'Requested journey date is outside the 30-day detailed-data window';
  END IF;
  RETURN QUERY
  SELECT
    journey.service_date,
    journey.id,
    journey.source_trip_id,
    line.slug,
    line.public_code,
    journey.direction,
    journey.lifecycle_status,
    journey.scheduled_start_at,
    journey.scheduled_end_at,
    stop.stop_sequence,
    station.public_id,
    station.name_es,
    station.name_en,
    stop.scheduled_arrival_at,
    stop.renfe_arrival_at,
    stop.renfe_arrival_delay_seconds,
    stop.derived_delay_seconds,
    stop.selected_delay_seconds,
    stop.selected_delay_source,
    stop.first_stopped_presence_at,
    stop.evidence_status,
    stop.evidence_selected_captured_at,
    stop.canonical_algorithm_version
  FROM core.journey AS journey
  JOIN core.line AS line ON line.id = journey.line_id
  JOIN core.journey_stop AS stop
    ON stop.service_date = journey.service_date AND stop.journey_id = journey.id
  JOIN core.station AS station ON station.id = stop.station_id
  WHERE journey.service_date = requested_service_date AND journey.id = requested_journey_id
  ORDER BY stop.stop_sequence
  LIMIT 250;
END
$function$;

REVOKE ALL ON ALL TABLES IN SCHEMA api FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA api FROM PUBLIC;
