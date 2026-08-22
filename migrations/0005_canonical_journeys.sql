-- Milestone 3: replay-safe canonical journeys derived from retained realtime evidence.

SET LOCAL ROLE atodotren_migration_admin;

CREATE OR REPLACE FUNCTION core.service_instant(
  service_date date,
  service_seconds integer,
  timezone_name text
)
RETURNS timestamptz
LANGUAGE sql
STABLE
STRICT
PARALLEL SAFE
AS $function$
  SELECT (service_date::timestamp + make_interval(secs => service_seconds)) AT TIME ZONE timezone_name
$function$;

CREATE TABLE core.journey (
  service_date date NOT NULL,
  id bigint GENERATED ALWAYS AS IDENTITY,
  network_id bigint NOT NULL REFERENCES core.network(id),
  feed_version_id bigint NOT NULL,
  source_trip_id text NOT NULL,
  start_time text,
  start_date_source text NOT NULL CHECK (start_date_source IN ('provided', 'inferred')),
  line_id bigint NOT NULL REFERENCES core.line(id),
  branch_id bigint NOT NULL REFERENCES core.branch(id),
  direction smallint CHECK (direction IN (0, 1)),
  service_pattern_id bigint NOT NULL REFERENCES core.service_pattern(id),
  scheduled_start_seconds integer NOT NULL CHECK (scheduled_start_seconds BETWEEN 0 AND 359999),
  scheduled_end_seconds integer NOT NULL CHECK (scheduled_end_seconds BETWEEN scheduled_start_seconds AND 359999),
  scheduled_start_at timestamptz NOT NULL,
  scheduled_end_at timestamptz NOT NULL,
  trip_relationship text NOT NULL,
  lifecycle_status text NOT NULL DEFAULT 'open'
    CHECK (lifecycle_status IN ('open', 'canceled', 'partially_canceled', 'closed')),
  matching_method text NOT NULL CHECK (matching_method IN (
    'active-exact-trip', 'previous-exact-trip', 'active-unique-fallback', 'previous-unique-fallback'
  )),
  matching_version text NOT NULL CHECK (length(matching_version) BETWEEN 1 AND 40),
  matching_confidence real NOT NULL CHECK (matching_confidence BETWEEN 0 AND 1),
  canonical_algorithm_version text NOT NULL CHECK (length(canonical_algorithm_version) BETWEEN 1 AND 40),
  first_evidence_at timestamptz NOT NULL,
  last_evidence_at timestamptz NOT NULL,
  finalized_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  repair_version integer NOT NULL DEFAULT 0 CHECK (repair_version >= 0),
  repaired_at timestamptz,
  repair_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (service_date, id),
  UNIQUE NULLS NOT DISTINCT (service_date, network_id, feed_version_id, source_trip_id, start_time),
  FOREIGN KEY (feed_version_id, source_trip_id)
    REFERENCES gtfs_static.trip(feed_version_id, trip_id),
  CHECK (scheduled_end_at >= scheduled_start_at),
  CHECK (last_evidence_at >= first_evidence_at),
  CHECK ((lifecycle_status = 'open') = (finalized_at IS NULL)),
  CHECK ((repair_version = 0 AND repaired_at IS NULL AND repair_reason IS NULL)
    OR (repair_version > 0 AND repaired_at IS NOT NULL AND btrim(repair_reason) <> ''))
) PARTITION BY RANGE (service_date);

CREATE INDEX journey_source_lookup_idx
  ON core.journey (service_date, feed_version_id, source_trip_id, start_time);
CREATE INDEX journey_network_id_idx ON core.journey (network_id);
CREATE INDEX journey_feed_trip_idx ON core.journey (feed_version_id, source_trip_id);
CREATE INDEX journey_branch_id_idx ON core.journey (branch_id);
CREATE INDEX journey_service_pattern_id_idx ON core.journey (service_pattern_id);
CREATE INDEX journey_route_day_idx
  ON core.journey (line_id, branch_id, direction, service_date DESC);
CREATE INDEX journey_closure_idx
  ON core.journey (scheduled_end_at, service_date, id) WHERE finalized_at IS NULL;

CREATE TABLE core.journey_stop (
  service_date date NOT NULL,
  journey_id bigint NOT NULL,
  stop_sequence integer NOT NULL CHECK (stop_sequence >= 0),
  station_id bigint NOT NULL REFERENCES core.station(id),
  feed_version_id bigint NOT NULL,
  source_trip_id text NOT NULL,
  source_stop_id text NOT NULL,
  scheduled_arrival_seconds integer NOT NULL CHECK (scheduled_arrival_seconds BETWEEN 0 AND 359999),
  scheduled_arrival_at timestamptz NOT NULL,
  renfe_arrival_at timestamptz,
  renfe_arrival_delay_seconds integer,
  derived_delay_seconds integer,
  delay_discrepancy_seconds integer,
  first_stopped_presence_at timestamptz,
  selected_delay_seconds integer,
  selected_delay_source text CHECK (selected_delay_source IN ('arrival_time', 'provided_delay')),
  evidence_status text NOT NULL DEFAULT 'pending'
    CHECK (evidence_status IN (
      'pending', 'reported_only', 'observed_presence', 'skipped', 'canceled', 'missing_evidence'
    )),
  evidence_first_captured_at timestamptz,
  evidence_selected_captured_at timestamptz,
  evidence_selected_source_at timestamptz,
  evidence_selected_idempotency_key text CHECK (
    evidence_selected_idempotency_key IS NULL OR evidence_selected_idempotency_key ~ '^[0-9a-f]{64}$'
  ),
  stop_relationship text NOT NULL DEFAULT 'SCHEDULED',
  matching_method text NOT NULL,
  matching_version text NOT NULL CHECK (length(matching_version) BETWEEN 1 AND 40),
  canonical_algorithm_version text NOT NULL CHECK (length(canonical_algorithm_version) BETWEEN 1 AND 40),
  finalized_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  repair_version integer NOT NULL DEFAULT 0 CHECK (repair_version >= 0),
  repaired_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (service_date, journey_id, stop_sequence),
  FOREIGN KEY (service_date, journey_id)
    REFERENCES core.journey(service_date, id),
  FOREIGN KEY (feed_version_id, source_trip_id, stop_sequence)
    REFERENCES gtfs_static.stop_time(feed_version_id, trip_id, stop_sequence),
  FOREIGN KEY (feed_version_id, source_stop_id)
    REFERENCES gtfs_static.stop(feed_version_id, stop_id),
  CHECK ((renfe_arrival_at IS NULL) = (derived_delay_seconds IS NULL)),
  CHECK (delay_discrepancy_seconds IS NULL OR
    delay_discrepancy_seconds = renfe_arrival_delay_seconds - derived_delay_seconds),
  CHECK ((selected_delay_seconds IS NULL) = (selected_delay_source IS NULL)),
  CHECK (selected_delay_source <> 'arrival_time' OR selected_delay_seconds = derived_delay_seconds),
  CHECK (selected_delay_source <> 'provided_delay' OR selected_delay_seconds = renfe_arrival_delay_seconds),
  CHECK (evidence_status NOT IN ('pending', 'missing_evidence', 'canceled')
    OR selected_delay_seconds IS NULL OR evidence_selected_captured_at IS NOT NULL)
) PARTITION BY RANGE (service_date);

CREATE INDEX journey_stop_ordered_idx ON core.journey_stop (journey_id, stop_sequence);
CREATE INDEX journey_stop_station_day_idx ON core.journey_stop (station_id, service_date DESC);
CREATE INDEX journey_stop_source_trip_idx
  ON core.journey_stop (feed_version_id, source_trip_id, stop_sequence);
CREATE INDEX journey_stop_source_stop_idx ON core.journey_stop (feed_version_id, source_stop_id);
CREATE INDEX journey_stop_adjacent_idx ON core.journey_stop (service_date, journey_id, stop_sequence, station_id);

CREATE OR REPLACE FUNCTION core.guard_canonical_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  old_closed boolean;
BEGIN
  IF to_jsonb(OLD) ? 'journey_id' THEN
    SELECT finalized_at IS NOT NULL INTO old_closed
    FROM core.journey
    WHERE service_date = OLD.service_date AND id = OLD.journey_id;
    IF OLD.first_stopped_presence_at IS NOT NULL
      AND NEW.first_stopped_presence_at IS DISTINCT FROM OLD.first_stopped_presence_at
    THEN
      RAISE EXCEPTION 'First stopped presence is immutable';
    END IF;
  ELSE
    old_closed := OLD.finalized_at IS NOT NULL;
  END IF;
  IF old_closed AND NOT (
    NEW.repair_version > OLD.repair_version
    AND NEW.repaired_at IS NOT NULL
    AND NEW.canonical_algorithm_version <> OLD.canonical_algorithm_version
  ) THEN
    RAISE EXCEPTION 'Closed canonical rows require an explicit versioned repair';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER journey_mutation_guard
BEFORE UPDATE ON core.journey
FOR EACH ROW EXECUTE FUNCTION core.guard_canonical_mutation();
CREATE TRIGGER journey_stop_mutation_guard
BEFORE UPDATE ON core.journey_stop
FOR EACH ROW EXECUTE FUNCTION core.guard_canonical_mutation();

CREATE OR REPLACE FUNCTION core.ensure_journey_partitions(target_date date)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, core
AS $function$
DECLARE
  parent_name text;
  partition_name text;
BEGIN
  IF target_date < current_date - 35 OR target_date > current_date + 7 THEN
    RAISE EXCEPTION 'Journey partition date % is outside the permitted creation window', target_date;
  END IF;
  FOREACH parent_name IN ARRAY ARRAY['journey', 'journey_stop']
  LOOP
    partition_name := format('%s_%s', parent_name, to_char(target_date, 'YYYYMMDD'));
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS core.%I PARTITION OF core.%I FOR VALUES FROM (%L) TO (%L)',
      partition_name, parent_name, target_date, target_date + 1
    );
  END LOOP;
END
$function$;

SELECT core.ensure_journey_partitions(day_value::date)
FROM generate_series(current_date - 35, current_date + 2, interval '1 day') AS day_value;

CREATE OR REPLACE VIEW operations.canonical_health
WITH (security_invoker = true)
AS
SELECT
  count(*) FILTER (WHERE finalized_at IS NULL) AS open_journeys,
  count(*) FILTER (WHERE finalized_at IS NOT NULL) AS closed_journeys,
  min(scheduled_end_at) FILTER (WHERE finalized_at IS NULL) AS oldest_open_scheduled_end_at,
  max(updated_at) AS latest_canonical_update_at
FROM core.journey;

REVOKE ALL ON core.journey, core.journey_stop, operations.canonical_health FROM PUBLIC;
REVOKE ALL ON FUNCTION core.service_instant(date, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.guard_canonical_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION core.ensure_journey_partitions(date) FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON core.journey, core.journey_stop TO atodotren_ingest_writer;
GRANT USAGE, SELECT ON SEQUENCE core.journey_id_seq TO atodotren_ingest_writer;
GRANT EXECUTE ON FUNCTION core.service_instant(date, integer, text) TO atodotren_ingest_writer;
GRANT EXECUTE ON FUNCTION core.ensure_journey_partitions(date) TO atodotren_ingest_writer;
GRANT SELECT ON operations.canonical_health TO atodotren_ingest_writer;

GRANT SELECT ON core.journey, core.journey_stop, operations.canonical_health TO atodotren_backup_reader;
GRANT SELECT ON operations.canonical_health TO atodotren_monitor_reader;
GRANT USAGE ON SCHEMA core TO atodotren_monitor_reader;

ALTER DEFAULT PRIVILEGES FOR ROLE atodotren_migration_admin IN SCHEMA core
  REVOKE ALL ON TABLES FROM atodotren_ingest_writer;
ALTER DEFAULT PRIVILEGES FOR ROLE atodotren_migration_admin IN SCHEMA core
  REVOKE ALL ON SEQUENCES FROM atodotren_ingest_writer;
