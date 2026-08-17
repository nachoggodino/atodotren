-- Milestone 2: provider-neutral GTFS-Realtime evidence ingestion.

SET LOCAL ROLE atodotren_migration_admin;

CREATE TABLE ingest.poll_run (
  captured_at timestamptz NOT NULL,
  id bigint GENERATED ALWAYS AS IDENTITY,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  feed_kind text NOT NULL CHECK (feed_kind IN ('trip_updates', 'vehicle_positions', 'service_alerts')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  feed_header_timestamp bigint CHECK (feed_header_timestamp >= 0),
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  result_class text NOT NULL CHECK (result_class IN (
    'success', 'http_4xx', 'http_5xx', 'network_error', 'timeout', 'response_too_large',
    'invalid_protobuf', 'invalid_header', 'differential_unsupported', 'persistence_error'
  )),
  response_bytes bigint NOT NULL DEFAULT 0 CHECK (response_bytes >= 0),
  entity_total integer NOT NULL DEFAULT 0 CHECK (entity_total >= 0),
  matched_madrid_count integer NOT NULL DEFAULT 0 CHECK (matched_madrid_count >= 0),
  non_madrid_count integer NOT NULL DEFAULT 0 CHECK (non_madrid_count >= 0),
  unmatched_count integer NOT NULL DEFAULT 0 CHECK (unmatched_count >= 0),
  invalid_count integer NOT NULL DEFAULT 0 CHECK (invalid_count >= 0),
  evidence_changed_count integer NOT NULL DEFAULT 0 CHECK (evidence_changed_count >= 0),
  evidence_repeated_count integer NOT NULL DEFAULT 0 CHECK (evidence_repeated_count >= 0),
  response_duration_ms integer NOT NULL CHECK (response_duration_ms >= 0),
  persistence_duration_ms integer NOT NULL DEFAULT 0 CHECK (persistence_duration_ms >= 0),
  error_code text CHECK (error_code ~ '^[a-z0-9_.-]{1,80}$'),
  PRIMARY KEY (captured_at, id),
  UNIQUE (captured_at, idempotency_key),
  CHECK (completed_at >= started_at)
) PARTITION BY RANGE (captured_at);

CREATE INDEX poll_run_feed_captured_idx ON ingest.poll_run (feed_kind, captured_at DESC);
CREATE INDEX poll_run_success_captured_idx ON ingest.poll_run (captured_at DESC)
  WHERE result_class = 'success';

CREATE TABLE ingest.filtered_payload (
  captured_at timestamptz NOT NULL,
  id bigint GENERATED ALWAYS AS IDENTITY,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  feed_kind text NOT NULL CHECK (feed_kind IN ('trip_updates', 'vehicle_positions', 'service_alerts')),
  feed_header_timestamp bigint NOT NULL CHECK (feed_header_timestamp >= 0),
  content_checksum text NOT NULL CHECK (content_checksum ~ '^[0-9a-f]{64}$'),
  codec_version text NOT NULL CHECK (codec_version ~ '^[a-z0-9_.-]{1,40}$'),
  compressed_payload bytea NOT NULL CHECK (octet_length(compressed_payload) <= 33554432),
  uncompressed_bytes integer NOT NULL CHECK (uncompressed_bytes >= 0),
  entity_count integer NOT NULL CHECK (entity_count >= 0),
  PRIMARY KEY (captured_at, id),
  UNIQUE (captured_at, idempotency_key)
) PARTITION BY RANGE (captured_at);

CREATE INDEX filtered_payload_feed_captured_idx
  ON ingest.filtered_payload (feed_kind, captured_at DESC);

CREATE TABLE ingest.stop_evidence (
  captured_at timestamptz NOT NULL,
  id bigint GENERATED ALWAYS AS IDENTITY,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  evidence_key text NOT NULL CHECK (length(evidence_key) BETWEEN 1 AND 512),
  evidence_checksum text NOT NULL CHECK (evidence_checksum ~ '^[0-9a-f]{64}$'),
  feed_kind text NOT NULL CHECK (feed_kind IN ('trip_updates', 'vehicle_positions')),
  feed_version_id bigint NOT NULL,
  source_trip_id text NOT NULL,
  service_date date,
  start_time text,
  start_date_source text NOT NULL CHECK (start_date_source IN ('provided', 'inferred', 'missing')),
  stop_id text,
  stop_sequence integer CHECK (stop_sequence >= 0),
  station_id bigint REFERENCES core.station(id),
  renfe_arrival_time bigint,
  renfe_arrival_delay integer,
  trip_relationship text NOT NULL,
  stop_relationship text NOT NULL,
  source_timestamp bigint CHECK (source_timestamp >= 0),
  matching_method text NOT NULL CHECK (matching_method IN (
    'active-exact-trip', 'previous-exact-trip', 'active-unique-fallback', 'previous-unique-fallback'
  )),
  matching_version text NOT NULL CHECK (length(matching_version) BETWEEN 1 AND 40),
  evidence_classification text NOT NULL CHECK (evidence_classification IN (
    'reported_prediction', 'trip_cancellation', 'stop_skipped', 'observed_presence'
  )),
  PRIMARY KEY (captured_at, id),
  UNIQUE (captured_at, idempotency_key),
  FOREIGN KEY (feed_version_id, source_trip_id)
    REFERENCES gtfs_static.trip(feed_version_id, trip_id),
  FOREIGN KEY (feed_version_id, source_trip_id, stop_sequence)
    REFERENCES gtfs_static.stop_time(feed_version_id, trip_id, stop_sequence),
  CHECK (renfe_arrival_time IS NOT NULL OR renfe_arrival_delay IS NOT NULL
    OR evidence_classification IN ('trip_cancellation', 'stop_skipped', 'observed_presence')),
  CHECK (
    (evidence_classification = 'trip_cancellation' AND stop_id IS NULL AND stop_sequence IS NULL AND station_id IS NULL)
    OR
    (evidence_classification <> 'trip_cancellation' AND stop_id IS NOT NULL AND stop_sequence IS NOT NULL AND station_id IS NOT NULL)
  )
) PARTITION BY RANGE (captured_at);

CREATE INDEX stop_evidence_trip_stop_captured_idx
  ON ingest.stop_evidence (feed_version_id, source_trip_id, service_date, stop_sequence, captured_at DESC);
CREATE INDEX stop_evidence_station_captured_idx
  ON ingest.stop_evidence (station_id, captured_at DESC);
CREATE INDEX stop_evidence_key_captured_idx
  ON ingest.stop_evidence (evidence_key, captured_at DESC);

CREATE TABLE ingest.evidence_state (
  evidence_key text PRIMARY KEY CHECK (length(evidence_key) BETWEEN 1 AND 512),
  evidence_checksum text NOT NULL CHECK (evidence_checksum ~ '^[0-9a-f]{64}$'),
  last_idempotency_key text NOT NULL CHECK (last_idempotency_key ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL
);

CREATE TABLE ingest.quarantined_entity (
  captured_at timestamptz NOT NULL,
  id bigint GENERATED ALWAYS AS IDENTITY,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  feed_kind text NOT NULL CHECK (feed_kind IN ('trip_updates', 'vehicle_positions', 'service_alerts')),
  feed_header_timestamp bigint CHECK (feed_header_timestamp >= 0),
  entity_id text CHECK (length(entity_id) <= 256),
  trip_id text CHECK (length(trip_id) <= 256),
  route_id text CHECK (length(route_id) <= 256),
  stop_id text CHECK (length(stop_id) <= 256),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z0-9_.-]{1,80}$'),
  diagnostic_fields jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(diagnostic_fields) = 'object' AND octet_length(diagnostic_fields::text) <= 4096),
  PRIMARY KEY (captured_at, id),
  UNIQUE (captured_at, idempotency_key)
) PARTITION BY RANGE (captured_at);

CREATE INDEX quarantined_reason_captured_idx
  ON ingest.quarantined_entity (reason_code, captured_at DESC);

CREATE TABLE ingest.live_vehicle_state (
  state_key text PRIMARY KEY CHECK (length(state_key) BETWEEN 1 AND 512),
  feed_version_id bigint NOT NULL,
  source_trip_id text NOT NULL,
  service_date date,
  start_time text,
  line_id bigint NOT NULL REFERENCES core.line(id),
  branch_id bigint NOT NULL REFERENCES core.branch(id),
  service_pattern_id bigint NOT NULL REFERENCES core.service_pattern(id),
  vehicle_id text,
  entity_id text NOT NULL,
  latitude double precision CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision CHECK (longitude BETWEEN -180 AND 180),
  bearing real CHECK (bearing >= 0 AND bearing < 360),
  speed real CHECK (speed >= 0),
  current_stop_sequence integer CHECK (current_stop_sequence >= 0),
  current_stop_id text,
  current_station_id bigint REFERENCES core.station(id),
  current_status text NOT NULL CHECK (current_status IN ('INCOMING_AT', 'STOPPED_AT', 'IN_TRANSIT_TO', 'UNKNOWN')),
  latest_stop_delay integer,
  vehicle_timestamp bigint CHECK (vehicle_timestamp >= 0),
  feed_header_timestamp bigint NOT NULL CHECK (feed_header_timestamp >= 0),
  captured_at timestamptz NOT NULL,
  shape_id text,
  projection_input text NOT NULL DEFAULT 'raw_position'
    CHECK (projection_input IN ('raw_position', 'stop_sequence', 'stop_id', 'none')),
  projection_confidence real CHECK (projection_confidence BETWEEN 0 AND 1),
  content_checksum text NOT NULL CHECK (content_checksum ~ '^[0-9a-f]{64}$'),
  FOREIGN KEY (feed_version_id, source_trip_id)
    REFERENCES gtfs_static.trip(feed_version_id, trip_id),
  FOREIGN KEY (feed_version_id, shape_id)
    REFERENCES gtfs_static.shape(feed_version_id, shape_id),
  CHECK ((latitude IS NULL) = (longitude IS NULL))
);

CREATE INDEX live_vehicle_trip_idx
  ON ingest.live_vehicle_state (feed_version_id, source_trip_id, service_date);
CREATE INDEX live_vehicle_freshness_idx ON ingest.live_vehicle_state (captured_at DESC);

CREATE TABLE ingest.service_alert (
  source_alert_id text PRIMARY KEY CHECK (length(source_alert_id) BETWEEN 1 AND 256),
  feed_header_timestamp bigint NOT NULL CHECK (feed_header_timestamp >= 0),
  captured_at timestamptz NOT NULL,
  active_periods jsonb NOT NULL CHECK (jsonb_typeof(active_periods) = 'array'),
  cause text NOT NULL,
  effect text NOT NULL,
  header_text text NOT NULL,
  description_text text NOT NULL,
  url text,
  content_checksum text NOT NULL CHECK (content_checksum ~ '^[0-9a-f]{64}$'),
  is_active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX service_alert_active_idx ON ingest.service_alert (captured_at DESC) WHERE is_active;

CREATE TABLE ingest.service_alert_target (
  source_alert_id text NOT NULL REFERENCES ingest.service_alert(source_alert_id) ON DELETE CASCADE,
  target_order integer NOT NULL CHECK (target_order >= 0),
  feed_version_id bigint REFERENCES gtfs_static.feed_version(id),
  route_id text,
  line_id bigint REFERENCES core.line(id),
  stop_id text,
  station_id bigint REFERENCES core.station(id),
  trip_id text,
  PRIMARY KEY (source_alert_id, target_order),
  FOREIGN KEY (feed_version_id, route_id)
    REFERENCES gtfs_static.route(feed_version_id, route_id),
  FOREIGN KEY (feed_version_id, stop_id)
    REFERENCES gtfs_static.stop(feed_version_id, stop_id),
  FOREIGN KEY (feed_version_id, trip_id)
    REFERENCES gtfs_static.trip(feed_version_id, trip_id),
  CHECK (route_id IS NOT NULL OR stop_id IS NOT NULL OR trip_id IS NOT NULL)
);

CREATE INDEX service_alert_target_line_idx ON ingest.service_alert_target (line_id)
  WHERE line_id IS NOT NULL;
CREATE INDEX service_alert_target_station_idx ON ingest.service_alert_target (station_id)
  WHERE station_id IS NOT NULL;
CREATE INDEX service_alert_target_trip_idx ON ingest.service_alert_target (feed_version_id, trip_id)
  WHERE trip_id IS NOT NULL;

CREATE TABLE operations.ingest_health (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_durable_cycle_at timestamptz,
  last_postgres_cycle_at timestamptz,
  last_heartbeat_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_failure_code text,
  spool_pending_count bigint NOT NULL DEFAULT 0 CHECK (spool_pending_count >= 0),
  spool_bytes bigint NOT NULL DEFAULT 0 CHECK (spool_bytes >= 0),
  spool_dropped_count bigint NOT NULL DEFAULT 0 CHECK (spool_dropped_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO operations.ingest_health (singleton) VALUES (true);

CREATE TABLE operations.notification_incident (
  incident_key text PRIMARY KEY CHECK (incident_key ~ '^[a-z0-9_.-]{1,80}$'),
  opened_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  last_notified_at timestamptz,
  occurrence_count integer NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  is_open boolean NOT NULL DEFAULT true,
  recovered_at timestamptz,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object')
);

CREATE OR REPLACE FUNCTION ingest.ensure_realtime_partitions(target_date date)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ingest
AS $function$
DECLARE
  parent_name text;
  partition_name text;
BEGIN
  IF target_date < current_date - 2 OR target_date > current_date + 7 THEN
    RAISE EXCEPTION 'Realtime partition date % is outside the permitted creation window', target_date;
  END IF;
  FOREACH parent_name IN ARRAY ARRAY['poll_run', 'filtered_payload', 'stop_evidence', 'quarantined_entity']
  LOOP
    partition_name := format('%s_%s', parent_name, to_char(target_date, 'YYYYMMDD'));
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS ingest.%I PARTITION OF ingest.%I FOR VALUES FROM (%L) TO (%L)',
      partition_name, parent_name, target_date::timestamptz, (target_date + 1)::timestamptz
    );
  END LOOP;
END
$function$;

SELECT ingest.ensure_realtime_partitions(day_value::date)
FROM generate_series(current_date - 2, current_date + 2, interval '1 day') AS day_value;

CREATE OR REPLACE VIEW operations.realtime_health
WITH (security_invoker = true)
AS
SELECT
  health.*,
  (SELECT max(captured_at) FROM ingest.poll_run WHERE result_class = 'success') AS latest_successful_poll_at,
  (SELECT count(*) FROM ingest.live_vehicle_state) AS live_vehicle_count,
  (SELECT count(*) FROM operations.notification_incident WHERE is_open) AS open_incident_count
FROM operations.ingest_health AS health;

REVOKE ALL ON ALL TABLES IN SCHEMA ingest FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA ingest FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ingest FROM PUBLIC;
REVOKE ALL ON operations.ingest_health, operations.notification_incident, operations.realtime_health FROM PUBLIC;

GRANT SELECT ON ALL TABLES IN SCHEMA ingest TO atodotren_ingest_writer;
GRANT INSERT ON ingest.poll_run, ingest.filtered_payload, ingest.stop_evidence,
  ingest.quarantined_entity TO atodotren_ingest_writer;
GRANT INSERT, UPDATE ON ingest.evidence_state, ingest.live_vehicle_state,
  ingest.service_alert, ingest.service_alert_target TO atodotren_ingest_writer;
GRANT DELETE ON ingest.service_alert_target TO atodotren_ingest_writer;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ingest TO atodotren_ingest_writer;
GRANT EXECUTE ON FUNCTION ingest.ensure_realtime_partitions(date) TO atodotren_ingest_writer;
GRANT SELECT, UPDATE ON operations.ingest_health, operations.notification_incident
  TO atodotren_ingest_writer;
GRANT INSERT ON operations.notification_incident TO atodotren_ingest_writer;

GRANT SELECT ON operations.ingest_health, operations.notification_incident,
  operations.realtime_health TO atodotren_backup_reader;
GRANT SELECT ON operations.realtime_health TO atodotren_monitor_reader;

ALTER DEFAULT PRIVILEGES FOR ROLE atodotren_migration_admin IN SCHEMA ingest
  REVOKE ALL ON TABLES FROM atodotren_ingest_writer;
ALTER DEFAULT PRIVILEGES FOR ROLE atodotren_migration_admin IN SCHEMA ingest
  REVOKE ALL ON SEQUENCES FROM atodotren_ingest_writer;
