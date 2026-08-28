-- Frontend historical enrichment supported by retained daily segment aggregates.

SET LOCAL ROLE atodotren_migration_admin;

CREATE OR REPLACE VIEW api.history_segment_hour
WITH (security_barrier = true)
AS
SELECT
  network.slug AS network_slug,
  aggregate.service_date,
  line.slug AS line_slug,
  line.public_code,
  segment.id::text AS segment_id,
  aggregate.direction,
  aggregate.upstream_scheduled_hour AS scheduled_hour,
  from_station.public_id AS from_station_id,
  from_station.slug_es AS from_station_slug_es,
  from_station.slug_en AS from_station_slug_en,
  from_station.name_es AS from_station_name_es,
  from_station.name_en AS from_station_name_en,
  to_station.public_id AS to_station_id,
  to_station.slug_es AS to_station_slug_es,
  to_station.slug_en AS to_station_slug_en,
  to_station.name_es AS to_station_name_es,
  to_station.name_en AS to_station_name_en,
  aggregate.scheduled_opportunities,
  aggregate.valid_delay_observations,
  aggregate.punctual_count,
  aggregate.canceled_count,
  aggregate.missing_evidence_count,
  aggregate.signed_delay_sum,
  aggregate.delay_histogram,
  aggregate.source_coverage,
  aggregate.aggregate_algorithm_version,
  aggregate.aggregate_algorithm_version AS aggregate_algorithm_version_max
FROM analytics.daily_segment_hour AS aggregate
JOIN core.network AS network ON network.id = aggregate.network_id
JOIN core.line AS line ON line.id = aggregate.line_id
JOIN core.segment AS segment ON segment.id = aggregate.segment_id
JOIN core.station AS from_station ON from_station.id = segment.from_station_id
JOIN core.station AS to_station ON to_station.id = segment.to_station_id;

REVOKE ALL ON api.history_segment_hour FROM PUBLIC;
GRANT SELECT ON api.history_segment_hour TO atodotren_web_reader;
