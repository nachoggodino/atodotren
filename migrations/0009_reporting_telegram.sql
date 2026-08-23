-- Milestone 5 CI-only readiness: least-privilege reporting surfaces and Telegram-owned state.
-- Migrations 0001-0008 are immutable.

SET LOCAL ROLE atodotren_migration_admin;

DO $report_role$
DECLARE
  existing pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO existing FROM pg_roles WHERE rolname = 'atodotren_reporting_reader';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Required role atodotren_reporting_reader is missing; run the database role bootstrap first';
  ELSIF existing.rolcanlogin
    OR existing.rolsuper
    OR existing.rolcreatedb
    OR existing.rolcreaterole
    OR existing.rolreplication
    OR existing.rolbypassrls
  THEN
    RAISE EXCEPTION 'Required role atodotren_reporting_reader has unsafe attributes';
  END IF;
END
$report_role$;

GRANT USAGE ON SCHEMA operations TO atodotren_reporting_reader;
GRANT USAGE ON SCHEMA analytics TO atodotren_reporting_reader;
GRANT EXECUTE ON FUNCTION analytics.histogram_add(integer[], integer[]),
  analytics.histogram_sum(integer[])
TO atodotren_reporting_reader;

CREATE TABLE operations.reporting_alias (
  entity_kind text NOT NULL CHECK (entity_kind IN ('line', 'station')),
  entity_id bigint NOT NULL,
  alias text NOT NULL CHECK (length(btrim(alias)) BETWEEN 1 AND 100),
  PRIMARY KEY (entity_kind, entity_id, alias)
);

CREATE TABLE operations.telegram_checkpoint (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  next_update_id bigint NOT NULL DEFAULT 0 CHECK (next_update_id >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO operations.telegram_checkpoint (singleton) VALUES (true);

CREATE TABLE operations.telegram_delivery (
  delivery_key text PRIMARY KEY CHECK (length(delivery_key) BETWEEN 1 AND 220),
  delivery_type text NOT NULL CHECK (delivery_type IN (
    'command', 'digest_normal', 'digest_provisional', 'incident_active', 'incident_recovery', 'monitor_active', 'monitor_recovery'
  )),
  source_update_id bigint CHECK (source_update_id IS NULL OR source_update_id >= 0),
  service_date date,
  report_version text NOT NULL CHECK (report_version ~ '^[a-z0-9_.-]{1,40}$'),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  first_attempt_at timestamptz,
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  telegram_message_id bigint,
  failure_class text CHECK (failure_class IS NULL OR failure_class ~ '^[A-Za-z0-9_.-]{1,64}$'),
  expires_at timestamptz NOT NULL,
  CHECK (delivered_at IS NULL OR telegram_message_id IS NOT NULL)
);
CREATE UNIQUE INDEX telegram_delivery_source_update_idx
  ON operations.telegram_delivery (source_update_id)
  WHERE source_update_id IS NOT NULL;
CREATE INDEX telegram_delivery_expiry_idx ON operations.telegram_delivery (expires_at);

CREATE TABLE operations.telegram_callback (
  callback_id text PRIMARY KEY CHECK (callback_id ~ '^[A-Za-z0-9_-]{8,48}$'),
  entity_kind text NOT NULL CHECK (entity_kind IN ('line', 'station', 'train')),
  entity_id text NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 100),
  report_date date,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX telegram_callback_expiry_idx ON operations.telegram_callback (expires_at);

CREATE TABLE operations.telegram_monitor_episode (
  monitor_key text PRIMARY KEY CHECK (monitor_key ~ '^[a-z0-9_.-]{1,80}$'),
  opened_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  consecutive_count integer NOT NULL DEFAULT 1 CHECK (consecutive_count > 0),
  is_open boolean NOT NULL DEFAULT true,
  recovered_at timestamptz,
  CHECK ((is_open AND recovered_at IS NULL) OR NOT is_open)
);

CREATE OR REPLACE FUNCTION operations.report_normalize(value text)
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

CREATE OR REPLACE VIEW operations.report_line_lookup
WITH (security_barrier = true)
AS
SELECT
  line.id AS line_id,
  line.public_code,
  line.name_es,
  line.slug,
  line.display_order,
  operations.report_normalize(line.public_code) AS normalized_code,
  operations.report_normalize(line.name_es) AS normalized_name,
  operations.report_normalize(line.slug) AS normalized_slug,
  COALESCE(alias.aliases, ARRAY[]::text[]) AS aliases,
  concat_ws(' ',
    operations.report_normalize(line.public_code),
    operations.report_normalize(line.name_es),
    operations.report_normalize(line.slug),
    COALESCE(alias.normalized_aliases, '')
  ) AS normalized_search
FROM core.line AS line
LEFT JOIN LATERAL (
  SELECT array_agg(value.alias ORDER BY value.alias) AS aliases,
    string_agg(operations.report_normalize(value.alias), ' ' ORDER BY value.alias) AS normalized_aliases
  FROM operations.reporting_alias AS value
  WHERE value.entity_kind = 'line' AND value.entity_id = line.id
) AS alias ON true
WHERE line.is_active;

CREATE OR REPLACE VIEW operations.report_station_lookup
WITH (security_barrier = true)
AS
SELECT
  station.id AS station_id,
  station.public_id,
  station.name_es,
  station.slug_es,
  operations.report_normalize(station.public_id) AS normalized_public_id,
  operations.report_normalize(station.name_es) AS normalized_name,
  operations.report_normalize(station.slug_es) AS normalized_slug,
  COALESCE(alias.aliases, ARRAY[]::text[]) AS aliases,
  concat_ws(' ',
    operations.report_normalize(station.public_id),
    operations.report_normalize(station.name_es),
    operations.report_normalize(station.slug_es),
    COALESCE(alias.normalized_aliases, '')
  ) AS normalized_search
FROM core.station AS station
LEFT JOIN LATERAL (
  SELECT array_agg(value.alias ORDER BY value.alias) AS aliases,
    string_agg(operations.report_normalize(value.alias), ' ' ORDER BY value.alias) AS normalized_aliases
  FROM operations.reporting_alias AS value
  WHERE value.entity_kind = 'station' AND value.entity_id = station.id
) AS alias ON true
WHERE station.is_active;

CREATE OR REPLACE VIEW operations.report_daily_summary
WITH (security_barrier = true)
AS
SELECT
  value.service_date,
  sum(value.scheduled_opportunities)::bigint AS scheduled_opportunities,
  sum(value.valid_delay_observations)::bigint AS valid_delay_observations,
  sum(value.punctual_count)::bigint AS punctual_count,
  sum(value.canceled_count)::bigint AS canceled_count,
  sum(value.missing_evidence_count)::bigint AS missing_evidence_count,
  sum(value.signed_delay_sum)::bigint AS signed_delay_sum,
  analytics.histogram_sum(value.delay_histogram) AS delay_histogram,
  min(value.aggregate_algorithm_version) AS aggregate_algorithm_version,
  max(value.aggregate_algorithm_version) AS aggregate_algorithm_version_max
FROM analytics.daily_stop_call_hour AS value
GROUP BY value.service_date;

CREATE OR REPLACE VIEW operations.report_line_summary
WITH (security_barrier = true)
AS
SELECT
  value.service_date,
  value.line_id,
  line.public_code,
  line.name_es,
  sum(value.scheduled_opportunities)::bigint AS scheduled_opportunities,
  sum(value.valid_delay_observations)::bigint AS valid_delay_observations,
  sum(value.punctual_count)::bigint AS punctual_count,
  sum(value.canceled_count)::bigint AS canceled_count,
  sum(value.missing_evidence_count)::bigint AS missing_evidence_count,
  sum(value.signed_delay_sum)::bigint AS signed_delay_sum,
  analytics.histogram_sum(value.delay_histogram) AS delay_histogram,
  min(value.aggregate_algorithm_version) AS aggregate_algorithm_version,
  max(value.aggregate_algorithm_version) AS aggregate_algorithm_version_max
FROM analytics.daily_stop_call_hour AS value
JOIN core.line AS line ON line.id = value.line_id
GROUP BY value.service_date, value.line_id, line.public_code, line.name_es;

CREATE OR REPLACE VIEW operations.report_station_summary
WITH (security_barrier = true)
AS
SELECT
  value.service_date,
  value.station_id,
  station.public_id,
  station.name_es,
  sum(value.scheduled_opportunities)::bigint AS scheduled_opportunities,
  sum(value.valid_delay_observations)::bigint AS valid_delay_observations,
  sum(value.punctual_count)::bigint AS punctual_count,
  sum(value.canceled_count)::bigint AS canceled_count,
  sum(value.missing_evidence_count)::bigint AS missing_evidence_count,
  sum(value.signed_delay_sum)::bigint AS signed_delay_sum,
  analytics.histogram_sum(value.delay_histogram) AS delay_histogram,
  min(value.aggregate_algorithm_version) AS aggregate_algorithm_version,
  max(value.aggregate_algorithm_version) AS aggregate_algorithm_version_max
FROM analytics.daily_stop_call_hour AS value
JOIN core.station AS station ON station.id = value.station_id
GROUP BY value.service_date, value.station_id, station.public_id, station.name_es;

CREATE OR REPLACE VIEW operations.report_line_hour
WITH (security_barrier = true)
AS
SELECT
  value.service_date,
  value.line_id,
  value.scheduled_hour,
  sum(value.scheduled_opportunities)::bigint AS scheduled_opportunities,
  sum(value.valid_delay_observations)::bigint AS valid_delay_observations,
  sum(value.punctual_count)::bigint AS punctual_count,
  sum(value.signed_delay_sum)::bigint AS signed_delay_sum,
  analytics.histogram_sum(value.delay_histogram) AS delay_histogram
FROM analytics.daily_stop_call_hour AS value
GROUP BY value.service_date, value.line_id, value.scheduled_hour;

CREATE OR REPLACE VIEW operations.report_station_hour
WITH (security_barrier = true)
AS
SELECT
  value.service_date,
  value.station_id,
  value.scheduled_hour,
  sum(value.scheduled_opportunities)::bigint AS scheduled_opportunities,
  sum(value.valid_delay_observations)::bigint AS valid_delay_observations,
  sum(value.punctual_count)::bigint AS punctual_count,
  sum(value.signed_delay_sum)::bigint AS signed_delay_sum,
  analytics.histogram_sum(value.delay_histogram) AS delay_histogram
FROM analytics.daily_stop_call_hour AS value
GROUP BY value.service_date, value.station_id, value.scheduled_hour;

CREATE OR REPLACE VIEW operations.report_vehicle_live
WITH (security_barrier = true)
AS
SELECT
  state.state_key,
  state.captured_at,
  state.service_date,
  journey.id AS journey_id,
  state.source_trip_id,
  state.vehicle_id,
  state.line_id,
  line.public_code,
  line.name_es AS line_name_es,
  state.current_stop_sequence,
  state.current_station_id,
  station.name_es AS current_station_name_es,
  state.current_status,
  state.latest_stop_delay,
  state.vehicle_timestamp
FROM ingest.live_vehicle_state AS state
JOIN core.line AS line ON line.id = state.line_id
LEFT JOIN core.station AS station ON station.id = state.current_station_id
LEFT JOIN core.journey AS journey
  ON journey.service_date = state.service_date
 AND journey.feed_version_id = state.feed_version_id
 AND journey.source_trip_id = state.source_trip_id;

CREATE OR REPLACE VIEW operations.report_journey_recent
WITH (security_barrier = true)
AS
SELECT
  journey.service_date,
  journey.id AS journey_id,
  journey.source_trip_id,
  journey.start_time,
  journey.line_id,
  line.public_code,
  line.name_es AS line_name_es,
  journey.lifecycle_status,
  journey.scheduled_start_at,
  journey.scheduled_end_at,
  journey.first_evidence_at,
  journey.last_evidence_at,
  journey.finalized_at,
  final_stop.station_id AS final_station_id,
  final_station.name_es AS final_station_name_es,
  final_stop.evidence_status AS final_evidence_status,
  final_stop.selected_delay_seconds AS final_delay_seconds
FROM core.journey AS journey
JOIN core.line AS line ON line.id = journey.line_id
LEFT JOIN LATERAL (
  SELECT stop.station_id, stop.evidence_status, stop.selected_delay_seconds
  FROM core.journey_stop AS stop
  WHERE stop.service_date = journey.service_date AND stop.journey_id = journey.id
  ORDER BY stop.stop_sequence DESC
  LIMIT 1
) AS final_stop ON true
LEFT JOIN core.station AS final_station ON final_station.id = final_stop.station_id;

CREATE OR REPLACE VIEW operations.report_ingest_health
WITH (security_barrier = true)
AS
SELECT
  health.last_durable_cycle_at,
  health.last_postgres_cycle_at,
  health.consecutive_failures,
  health.spool_pending_count,
  health.spool_bytes,
  health.spool_dropped_count,
  health.updated_at,
  (SELECT max(poll.captured_at) FROM ingest.poll_run AS poll WHERE poll.result_class = 'success') AS latest_successful_poll_at,
  (SELECT count(*) FROM ingest.live_vehicle_state) AS live_vehicle_count,
  (SELECT count(*) FROM operations.notification_incident AS incident WHERE incident.is_open) AS open_incident_count
FROM operations.ingest_health AS health;

CREATE OR REPLACE VIEW operations.report_canonical_health
WITH (security_barrier = true)
AS
SELECT
  count(*) FILTER (WHERE journey.finalized_at IS NULL) AS open_journeys,
  count(*) FILTER (WHERE journey.finalized_at IS NOT NULL) AS closed_journeys,
  min(journey.scheduled_end_at) FILTER (WHERE journey.finalized_at IS NULL) AS oldest_open_scheduled_end_at,
  max(journey.updated_at) AS latest_canonical_update_at
FROM core.journey AS journey;

CREATE OR REPLACE VIEW operations.report_finalization
WITH (security_barrier = true)
AS
SELECT service_date, aggregate_algorithm_version, status, finalized_at,
  source_journey_count, source_stop_count, source_segment_count
FROM operations.service_day_finalization;

CREATE OR REPLACE VIEW operations.report_feed_coverage
WITH (security_barrier = true)
AS
SELECT service_date, feed_kind, poll_count, successful_poll_count, matched_madrid_count,
  non_madrid_count, unmatched_count, invalid_count, evidence_changed_count, response_bytes,
  first_poll_at, last_poll_at
FROM operations.daily_feed_coverage;

CREATE OR REPLACE VIEW operations.report_incident_episode
WITH (security_barrier = true)
AS
SELECT incident_key, opened_at, last_observed_at, occurrence_count, is_open, recovered_at
FROM operations.notification_incident;

CREATE OR REPLACE VIEW operations.report_static_age
WITH (security_barrier = true)
AS
SELECT network.id AS network_id, network.name_es,
  max(version.fetched_at) FILTER (WHERE version.status = 'active') AS active_fetched_at,
  max(version.activated_at) FILTER (WHERE version.status = 'active') AS active_activated_at
FROM core.network AS network
LEFT JOIN gtfs_static.feed_version AS version ON version.network_id = network.id
GROUP BY network.id, network.name_es;

CREATE OR REPLACE VIEW operations.report_database_size
WITH (security_barrier = true)
AS
SELECT
  clock_timestamp() AS checked_at,
  pg_database_size(current_database())::bigint AS database_bytes,
  COALESCE((SELECT sum(pg_total_relation_size(relid))::bigint FROM pg_partition_tree('ingest.poll_run'::regclass)), 0) AS poll_run_bytes,
  COALESCE((SELECT sum(pg_total_relation_size(relid))::bigint FROM pg_partition_tree('ingest.stop_evidence'::regclass)), 0) AS stop_evidence_bytes,
  COALESCE((SELECT sum(pg_total_relation_size(relid))::bigint FROM pg_partition_tree('core.journey'::regclass)), 0) AS journey_bytes,
  COALESCE(pg_total_relation_size('analytics.daily_stop_call_hour'::regclass), 0)::bigint AS daily_aggregate_bytes;

CREATE OR REPLACE FUNCTION operations.telegram_prune_state(reference_time timestamptz DEFAULT clock_timestamp())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, operations
AS $function$
DECLARE
  deleted_deliveries integer;
  deleted_callbacks integer;
  deleted_monitors integer;
BEGIN
  DELETE FROM operations.telegram_delivery WHERE expires_at < reference_time;
  GET DIAGNOSTICS deleted_deliveries = ROW_COUNT;
  DELETE FROM operations.telegram_callback WHERE expires_at < reference_time;
  GET DIAGNOSTICS deleted_callbacks = ROW_COUNT;
  DELETE FROM operations.telegram_monitor_episode
  WHERE NOT is_open AND recovered_at < reference_time - interval '30 days';
  GET DIAGNOSTICS deleted_monitors = ROW_COUNT;
  RETURN jsonb_build_object(
    'deliveries', deleted_deliveries,
    'callbacks', deleted_callbacks,
    'monitors', deleted_monitors
  );
END
$function$;

REVOKE ALL ON operations.reporting_alias,
  operations.telegram_checkpoint,
  operations.telegram_delivery,
  operations.telegram_callback,
  operations.telegram_monitor_episode
FROM PUBLIC;
REVOKE ALL ON operations.report_line_lookup,
  operations.report_station_lookup,
  operations.report_daily_summary,
  operations.report_line_summary,
  operations.report_station_summary,
  operations.report_line_hour,
  operations.report_station_hour,
  operations.report_vehicle_live,
  operations.report_journey_recent,
  operations.report_ingest_health,
  operations.report_canonical_health,
  operations.report_finalization,
  operations.report_feed_coverage,
  operations.report_incident_episode,
  operations.report_static_age,
  operations.report_database_size
FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.report_normalize(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.telegram_prune_state(timestamptz) FROM PUBLIC;

GRANT SELECT ON operations.report_line_lookup,
  operations.report_station_lookup,
  operations.report_daily_summary,
  operations.report_line_summary,
  operations.report_station_summary,
  operations.report_line_hour,
  operations.report_station_hour,
  operations.report_vehicle_live,
  operations.report_journey_recent,
  operations.report_ingest_health,
  operations.report_canonical_health,
  operations.report_finalization,
  operations.report_feed_coverage,
  operations.report_incident_episode,
  operations.report_static_age,
  operations.report_database_size
TO atodotren_reporting_reader;

GRANT SELECT, INSERT, UPDATE ON operations.telegram_checkpoint,
  operations.telegram_delivery,
  operations.telegram_callback,
  operations.telegram_monitor_episode
TO atodotren_reporting_reader;
GRANT EXECUTE ON FUNCTION operations.telegram_prune_state(timestamptz)
TO atodotren_reporting_reader;

-- reporting_alias is migration-owned reference data. Runtime reporting can observe
-- aliases only through the approved lookup views and cannot mutate the alias table.
