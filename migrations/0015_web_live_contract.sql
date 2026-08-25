-- Frontend alpha: complete live metadata and journey identity in the approved API schema.

SET LOCAL ROLE atodotren_migration_admin;

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
  state.vehicle_timestamp,
  journey.id AS journey_id
FROM ingest.live_vehicle_state AS state
JOIN core.line AS line ON line.id = state.line_id
JOIN core.network AS network ON network.id = line.network_id
LEFT JOIN core.station AS station ON station.id = state.current_station_id
LEFT JOIN core.journey AS journey
  ON journey.service_date = state.service_date
 AND journey.feed_version_id = state.feed_version_id
 AND journey.source_trip_id = state.source_trip_id;

CREATE OR REPLACE VIEW api.live_health
WITH (security_barrier = true)
AS
SELECT
  health.last_durable_cycle_at,
  health.last_postgres_cycle_at,
  health.consecutive_failures,
  health.updated_at,
  (SELECT max(poll.captured_at) FROM ingest.poll_run AS poll WHERE poll.result_class = 'success') AS latest_successful_poll_at,
  (SELECT count(*) FROM ingest.live_vehicle_state) AS live_vehicle_count
FROM operations.ingest_health AS health;

CREATE OR REPLACE VIEW api.history_network_hour
WITH (security_barrier = true)
AS
SELECT
  network.slug AS network_slug,
  aggregate.service_date,
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
JOIN core.network AS network ON network.id = aggregate.network_id
GROUP BY network.slug, aggregate.service_date, aggregate.direction, aggregate.scheduled_hour;

REVOKE ALL ON api.live_vehicle, api.live_health, api.history_network_hour FROM PUBLIC;
GRANT SELECT ON api.live_vehicle, api.live_health, api.history_network_hour TO atodotren_web_reader;
