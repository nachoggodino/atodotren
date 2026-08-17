-- Atodotren Milestone 1 static Madrid foundation.
-- All source identifiers are scoped by feed_version_id. Successful versions are immutable.

SET LOCAL ROLE atodotren_migration_admin;

CREATE TABLE core.network (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name_es text NOT NULL CHECK (btrim(name_es) <> ''),
  name_en text NOT NULL CHECK (btrim(name_en) <> ''),
  timezone text NOT NULL CHECK (btrim(timezone) <> ''),
  active_from date,
  active_until date,
  is_active boolean NOT NULL DEFAULT true,
  CHECK (active_until IS NULL OR active_from IS NULL OR active_until >= active_from)
);

INSERT INTO core.network (slug, name_es, name_en, timezone)
VALUES ('madrid', 'Cercanías Madrid', 'Madrid commuter rail', 'Europe/Madrid');

CREATE TABLE core.station (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  network_id bigint NOT NULL REFERENCES core.network(id),
  public_id text NOT NULL CHECK (public_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  slug_es text NOT NULL CHECK (slug_es ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  slug_en text NOT NULL CHECK (slug_en ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name_es text NOT NULL CHECK (btrim(name_es) <> ''),
  name_en text NOT NULL CHECK (btrim(name_en) <> ''),
  latitude double precision CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision CHECK (longitude BETWEEN -180 AND 180),
  active_from date,
  active_until date,
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (network_id, public_id),
  UNIQUE (network_id, slug_es),
  UNIQUE (network_id, slug_en),
  CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CHECK (active_until IS NULL OR active_from IS NULL OR active_until >= active_from)
);
CREATE INDEX station_network_id_idx ON core.station (network_id);

CREATE TABLE core.line (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  network_id bigint NOT NULL REFERENCES core.network(id),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  public_code text NOT NULL CHECK (btrim(public_code) <> ''),
  name_es text NOT NULL CHECK (btrim(name_es) <> ''),
  name_en text NOT NULL CHECK (btrim(name_en) <> ''),
  color text CHECK (color ~ '^[0-9A-Fa-f]{6}$'),
  text_color text CHECK (text_color ~ '^[0-9A-Fa-f]{6}$'),
  display_order integer NOT NULL DEFAULT 0,
  active_from date,
  active_until date,
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (network_id, slug),
  UNIQUE (network_id, public_code),
  CHECK (active_until IS NULL OR active_from IS NULL OR active_until >= active_from)
);
CREATE INDEX line_network_id_idx ON core.line (network_id);

CREATE TABLE core.branch (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  line_id bigint NOT NULL REFERENCES core.line(id),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name_es text NOT NULL CHECK (btrim(name_es) <> ''),
  name_en text NOT NULL CHECK (btrim(name_en) <> ''),
  origin_station_id bigint REFERENCES core.station(id),
  destination_station_id bigint REFERENCES core.station(id),
  display_order integer NOT NULL DEFAULT 0,
  active_from date,
  active_until date,
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (line_id, slug),
  CHECK (origin_station_id IS NULL OR destination_station_id IS NULL OR origin_station_id <> destination_station_id),
  CHECK (active_until IS NULL OR active_from IS NULL OR active_until >= active_from)
);
CREATE INDEX branch_line_id_idx ON core.branch (line_id);
CREATE INDEX branch_origin_station_id_idx ON core.branch (origin_station_id);
CREATE INDEX branch_destination_station_id_idx ON core.branch (destination_station_id);

CREATE TABLE core.service_pattern (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id bigint NOT NULL REFERENCES core.branch(id),
  public_id text NOT NULL CHECK (public_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  direction smallint NOT NULL CHECK (direction IN (0, 1)),
  pattern_hash text NOT NULL CHECK (pattern_hash ~ '^[0-9a-f]{64}$'),
  name_es text NOT NULL CHECK (btrim(name_es) <> ''),
  name_en text NOT NULL CHECK (btrim(name_en) <> ''),
  active_from date,
  active_until date,
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (branch_id, public_id),
  UNIQUE (branch_id, direction, pattern_hash),
  CHECK (active_until IS NULL OR active_from IS NULL OR active_until >= active_from)
);
CREATE INDEX service_pattern_branch_id_idx ON core.service_pattern (branch_id);

CREATE TABLE core.service_pattern_stop (
  service_pattern_id bigint NOT NULL REFERENCES core.service_pattern(id) ON DELETE CASCADE,
  stop_order integer NOT NULL CHECK (stop_order >= 0),
  station_id bigint NOT NULL REFERENCES core.station(id),
  PRIMARY KEY (service_pattern_id, stop_order)
);
CREATE INDEX service_pattern_stop_station_id_idx ON core.service_pattern_stop (station_id);

CREATE TABLE core.segment (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  service_pattern_id bigint NOT NULL REFERENCES core.service_pattern(id) ON DELETE CASCADE,
  segment_order integer NOT NULL CHECK (segment_order >= 0),
  from_station_id bigint NOT NULL REFERENCES core.station(id),
  to_station_id bigint NOT NULL REFERENCES core.station(id),
  UNIQUE (service_pattern_id, segment_order),
  CHECK (from_station_id <> to_station_id)
);
CREATE INDEX segment_service_pattern_id_idx ON core.segment (service_pattern_id);
CREATE INDEX segment_from_station_id_idx ON core.segment (from_station_id);
CREATE INDEX segment_to_station_id_idx ON core.segment (to_station_id);

CREATE OR REPLACE FUNCTION core.guard_topology_network()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  expected_network_id bigint;
  from_network_id bigint;
  to_network_id bigint;
BEGIN
  IF TG_TABLE_NAME = 'branch' THEN
    SELECT network_id INTO expected_network_id FROM core.line WHERE id = NEW.line_id;
    SELECT network_id INTO from_network_id FROM core.station WHERE id = NEW.origin_station_id;
    SELECT network_id INTO to_network_id FROM core.station WHERE id = NEW.destination_station_id;
  ELSE
    SELECT line.network_id INTO expected_network_id
    FROM core.service_pattern AS pattern
    JOIN core.branch AS branch ON branch.id = pattern.branch_id
    JOIN core.line AS line ON line.id = branch.line_id
    WHERE pattern.id = NEW.service_pattern_id;
    IF TG_TABLE_NAME = 'service_pattern_stop' THEN
      SELECT network_id INTO from_network_id FROM core.station WHERE id = NEW.station_id;
      to_network_id := expected_network_id;
    ELSE
      SELECT network_id INTO from_network_id FROM core.station WHERE id = NEW.from_station_id;
      SELECT network_id INTO to_network_id FROM core.station WHERE id = NEW.to_station_id;
    END IF;
  END IF;
  IF (from_network_id IS NOT NULL AND from_network_id <> expected_network_id)
    OR (to_network_id IS NOT NULL AND to_network_id <> expected_network_id)
  THEN
    RAISE EXCEPTION 'Stable topology cannot cross network boundaries';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER branch_network_guard
BEFORE INSERT OR UPDATE ON core.branch
FOR EACH ROW EXECUTE FUNCTION core.guard_topology_network();
CREATE TRIGGER service_pattern_stop_network_guard
BEFORE INSERT OR UPDATE ON core.service_pattern_stop
FOR EACH ROW EXECUTE FUNCTION core.guard_topology_network();
CREATE TRIGGER segment_network_guard
BEFORE INSERT OR UPDATE ON core.segment
FOR EACH ROW EXECUTE FUNCTION core.guard_topology_network();

CREATE TABLE gtfs_static.feed_version (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  network_id bigint NOT NULL REFERENCES core.network(id),
  source_url text NOT NULL CHECK (btrim(source_url) <> ''),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  etag text,
  last_modified text,
  archive_bytes bigint NOT NULL CHECK (archive_bytes >= 0),
  status text NOT NULL DEFAULT 'downloaded'
    CHECK (status IN ('downloaded', 'staged', 'validated', 'active', 'superseded', 'rejected')),
  fetched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  import_started_at timestamptz,
  validated_at timestamptz,
  activated_at timestamptz,
  rejected_at timestamptz,
  effective_from date,
  effective_until date,
  previous_feed_version_id bigint REFERENCES gtfs_static.feed_version(id),
  validation_report jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(validation_report) = 'object'),
  import_report jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(import_report) = 'object'),
  rejection_code text,
  rejection_message text,
  UNIQUE (network_id, sha256),
  CHECK (previous_feed_version_id IS NULL OR previous_feed_version_id <> id),
  CHECK (effective_until IS NULL OR effective_from IS NULL OR effective_until >= effective_from),
  CHECK ((status <> 'active' AND status <> 'superseded') OR activated_at IS NOT NULL),
  CHECK (status <> 'rejected' OR rejected_at IS NOT NULL)
);
CREATE INDEX feed_version_network_id_idx ON gtfs_static.feed_version (network_id);
CREATE INDEX feed_version_previous_feed_version_id_idx ON gtfs_static.feed_version (previous_feed_version_id);
CREATE INDEX feed_version_network_success_idx
  ON gtfs_static.feed_version (network_id, activated_at DESC)
  WHERE status IN ('active', 'superseded');
CREATE UNIQUE INDEX feed_version_one_active_per_network_idx
  ON gtfs_static.feed_version (network_id)
  WHERE status = 'active';

CREATE TABLE gtfs_static.stop (
  feed_version_id bigint NOT NULL REFERENCES gtfs_static.feed_version(id) ON DELETE RESTRICT,
  stop_id text NOT NULL CHECK (btrim(stop_id) <> ''),
  stop_code text,
  stop_name text NOT NULL CHECK (btrim(stop_name) <> ''),
  stop_desc text,
  stop_lat double precision CHECK (stop_lat BETWEEN -90 AND 90),
  stop_lon double precision CHECK (stop_lon BETWEEN -180 AND 180),
  location_type smallint CHECK (location_type BETWEEN 0 AND 4),
  parent_station text,
  wheelchair_boarding smallint CHECK (wheelchair_boarding BETWEEN 0 AND 2),
  platform_code text,
  PRIMARY KEY (feed_version_id, stop_id),
  CHECK ((stop_lat IS NULL) = (stop_lon IS NULL))
);

CREATE TABLE gtfs_static.route (
  feed_version_id bigint NOT NULL REFERENCES gtfs_static.feed_version(id) ON DELETE RESTRICT,
  route_id text NOT NULL CHECK (btrim(route_id) <> ''),
  agency_id text,
  route_short_name text,
  route_long_name text,
  route_desc text,
  route_type integer NOT NULL CHECK (route_type >= 0),
  route_url text,
  route_color text CHECK (route_color ~ '^[0-9A-Fa-f]{6}$'),
  route_text_color text CHECK (route_text_color ~ '^[0-9A-Fa-f]{6}$'),
  route_sort_order integer CHECK (route_sort_order >= 0),
  PRIMARY KEY (feed_version_id, route_id),
  CHECK (COALESCE(btrim(route_short_name), '') <> '' OR COALESCE(btrim(route_long_name), '') <> '')
);

CREATE TABLE gtfs_static.calendar_service (
  feed_version_id bigint NOT NULL REFERENCES gtfs_static.feed_version(id) ON DELETE RESTRICT,
  service_id text NOT NULL CHECK (btrim(service_id) <> ''),
  monday boolean NOT NULL DEFAULT false,
  tuesday boolean NOT NULL DEFAULT false,
  wednesday boolean NOT NULL DEFAULT false,
  thursday boolean NOT NULL DEFAULT false,
  friday boolean NOT NULL DEFAULT false,
  saturday boolean NOT NULL DEFAULT false,
  sunday boolean NOT NULL DEFAULT false,
  start_date date,
  end_date date,
  PRIMARY KEY (feed_version_id, service_id),
  CHECK ((start_date IS NULL) = (end_date IS NULL)),
  CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE TABLE gtfs_static.calendar_exception (
  feed_version_id bigint NOT NULL,
  service_id text NOT NULL,
  service_date date NOT NULL,
  exception_type smallint NOT NULL CHECK (exception_type IN (1, 2)),
  PRIMARY KEY (feed_version_id, service_id, service_date),
  FOREIGN KEY (feed_version_id, service_id)
    REFERENCES gtfs_static.calendar_service(feed_version_id, service_id) ON DELETE RESTRICT
);
CREATE INDEX calendar_exception_service_idx
  ON gtfs_static.calendar_exception (feed_version_id, service_id);

CREATE TABLE gtfs_static.shape (
  feed_version_id bigint NOT NULL REFERENCES gtfs_static.feed_version(id) ON DELETE RESTRICT,
  shape_id text NOT NULL CHECK (btrim(shape_id) <> ''),
  PRIMARY KEY (feed_version_id, shape_id)
);

CREATE TABLE gtfs_static.shape_point (
  feed_version_id bigint NOT NULL,
  shape_id text NOT NULL CHECK (btrim(shape_id) <> ''),
  point_sequence integer NOT NULL CHECK (point_sequence >= 0),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  distance_traveled double precision CHECK (distance_traveled >= 0),
  PRIMARY KEY (feed_version_id, shape_id, point_sequence),
  FOREIGN KEY (feed_version_id, shape_id)
    REFERENCES gtfs_static.shape(feed_version_id, shape_id) ON DELETE RESTRICT
);

CREATE TABLE gtfs_static.trip (
  feed_version_id bigint NOT NULL,
  trip_id text NOT NULL CHECK (btrim(trip_id) <> ''),
  route_id text NOT NULL,
  service_id text NOT NULL,
  trip_headsign text,
  trip_short_name text,
  direction_id smallint CHECK (direction_id IN (0, 1)),
  block_id text,
  shape_id text,
  wheelchair_accessible smallint CHECK (wheelchair_accessible BETWEEN 0 AND 2),
  bikes_allowed smallint CHECK (bikes_allowed BETWEEN 0 AND 2),
  PRIMARY KEY (feed_version_id, trip_id),
  FOREIGN KEY (feed_version_id, route_id)
    REFERENCES gtfs_static.route(feed_version_id, route_id) ON DELETE RESTRICT,
  FOREIGN KEY (feed_version_id, service_id)
    REFERENCES gtfs_static.calendar_service(feed_version_id, service_id) ON DELETE RESTRICT,
  FOREIGN KEY (feed_version_id, shape_id)
    REFERENCES gtfs_static.shape(feed_version_id, shape_id) ON DELETE RESTRICT
);
CREATE INDEX trip_route_id_idx ON gtfs_static.trip (feed_version_id, route_id);
CREATE INDEX trip_service_id_idx ON gtfs_static.trip (feed_version_id, service_id);
CREATE INDEX trip_shape_id_idx ON gtfs_static.trip (feed_version_id, shape_id) WHERE shape_id IS NOT NULL;

CREATE TABLE gtfs_static.stop_time (
  feed_version_id bigint NOT NULL,
  trip_id text NOT NULL,
  stop_sequence integer NOT NULL CHECK (stop_sequence >= 0),
  stop_id text NOT NULL,
  arrival_seconds integer CHECK (arrival_seconds BETWEEN 0 AND 359999),
  departure_seconds integer CHECK (departure_seconds BETWEEN 0 AND 359999),
  stop_headsign text,
  pickup_type smallint CHECK (pickup_type BETWEEN 0 AND 3),
  drop_off_type smallint CHECK (drop_off_type BETWEEN 0 AND 3),
  shape_dist_traveled double precision CHECK (shape_dist_traveled >= 0),
  timepoint smallint CHECK (timepoint IN (0, 1)),
  PRIMARY KEY (feed_version_id, trip_id, stop_sequence),
  FOREIGN KEY (feed_version_id, trip_id)
    REFERENCES gtfs_static.trip(feed_version_id, trip_id) ON DELETE RESTRICT,
  FOREIGN KEY (feed_version_id, stop_id)
    REFERENCES gtfs_static.stop(feed_version_id, stop_id) ON DELETE RESTRICT,
  CHECK (arrival_seconds IS NULL OR departure_seconds IS NULL OR departure_seconds >= arrival_seconds)
);
CREATE INDEX stop_time_stop_id_idx ON gtfs_static.stop_time (feed_version_id, stop_id);

CREATE TABLE gtfs_static.stop_station_map (
  feed_version_id bigint NOT NULL,
  stop_id text NOT NULL,
  station_id bigint NOT NULL REFERENCES core.station(id),
  mapping_rule text NOT NULL CHECK (btrim(mapping_rule) <> ''),
  PRIMARY KEY (feed_version_id, stop_id),
  FOREIGN KEY (feed_version_id, stop_id)
    REFERENCES gtfs_static.stop(feed_version_id, stop_id) ON DELETE RESTRICT
);
CREATE INDEX stop_station_map_station_id_idx ON gtfs_static.stop_station_map (station_id);

CREATE TABLE gtfs_static.route_line_map (
  feed_version_id bigint NOT NULL,
  route_id text NOT NULL,
  line_id bigint NOT NULL REFERENCES core.line(id),
  mapping_rule text NOT NULL CHECK (btrim(mapping_rule) <> ''),
  PRIMARY KEY (feed_version_id, route_id),
  FOREIGN KEY (feed_version_id, route_id)
    REFERENCES gtfs_static.route(feed_version_id, route_id) ON DELETE RESTRICT
);
CREATE INDEX route_line_map_line_id_idx ON gtfs_static.route_line_map (line_id);

CREATE TABLE gtfs_static.trip_pattern_map (
  feed_version_id bigint NOT NULL,
  trip_id text NOT NULL,
  branch_id bigint NOT NULL REFERENCES core.branch(id),
  service_pattern_id bigint NOT NULL REFERENCES core.service_pattern(id),
  mapping_rule text NOT NULL CHECK (btrim(mapping_rule) <> ''),
  PRIMARY KEY (feed_version_id, trip_id),
  FOREIGN KEY (feed_version_id, trip_id)
    REFERENCES gtfs_static.trip(feed_version_id, trip_id) ON DELETE RESTRICT
);
CREATE INDEX trip_pattern_map_branch_id_idx ON gtfs_static.trip_pattern_map (branch_id);
CREATE INDEX trip_pattern_map_service_pattern_id_idx ON gtfs_static.trip_pattern_map (service_pattern_id);

CREATE OR REPLACE FUNCTION gtfs_static.guard_feed_version_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.network_id <> OLD.network_id
    OR NEW.source_url <> OLD.source_url
    OR NEW.sha256 <> OLD.sha256
    OR NEW.archive_bytes <> OLD.archive_bytes
    OR NEW.fetched_at <> OLD.fetched_at
  THEN
    RAISE EXCEPTION 'Immutable feed identity fields cannot be changed for version %', OLD.id;
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'downloaded' AND NEW.status IN ('staged', 'rejected')) OR
    (OLD.status = 'staged' AND NEW.status IN ('validated', 'rejected')) OR
    (OLD.status = 'validated' AND NEW.status IN ('active', 'rejected')) OR
    (OLD.status = 'active' AND NEW.status = 'superseded')
  ) THEN
    RAISE EXCEPTION 'Invalid feed version transition % -> % for version %', OLD.status, NEW.status, OLD.id;
  END IF;
  IF OLD.status IN ('active', 'superseded', 'rejected') THEN
    IF NEW.status = OLD.status OR (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
      RAISE EXCEPTION 'Terminal feed version % is immutable', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER feed_version_transition_guard
BEFORE UPDATE ON gtfs_static.feed_version
FOR EACH ROW EXECUTE FUNCTION gtfs_static.guard_feed_version_transition();

CREATE OR REPLACE FUNCTION gtfs_static.analyze_static_tables()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, gtfs_static
AS $function$
BEGIN
  ANALYZE
    gtfs_static.stop, gtfs_static.route, gtfs_static.calendar_service,
    gtfs_static.calendar_exception, gtfs_static.shape, gtfs_static.shape_point,
    gtfs_static.trip, gtfs_static.stop_time, gtfs_static.stop_station_map,
    gtfs_static.route_line_map, gtfs_static.trip_pattern_map;
END
$function$;

CREATE OR REPLACE FUNCTION gtfs_static.guard_versioned_fact_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  candidate_id bigint;
  candidate_status text;
BEGIN
  candidate_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.feed_version_id ELSE NEW.feed_version_id END;
  SELECT status INTO candidate_status FROM gtfs_static.feed_version WHERE id = candidate_id;
  IF candidate_status NOT IN ('downloaded', 'staged', 'validated') THEN
    RAISE EXCEPTION 'Static facts for feed version % in status % are immutable', candidate_id, candidate_status;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;

DO $triggers$
DECLARE
  relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'stop', 'route', 'calendar_service', 'calendar_exception', 'shape', 'shape_point', 'trip',
    'stop_time', 'stop_station_map', 'route_line_map', 'trip_pattern_map'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER versioned_fact_guard BEFORE INSERT OR UPDATE OR DELETE ON gtfs_static.%I FOR EACH ROW EXECUTE FUNCTION gtfs_static.guard_versioned_fact_mutation()',
      relation_name
    );
  END LOOP;
END
$triggers$;

CREATE VIEW gtfs_static.current_feed_version
WITH (security_invoker = true)
AS
SELECT
  version.id,
  version.network_id,
  network.slug AS network_slug,
  version.source_url,
  version.sha256,
  version.etag,
  version.last_modified,
  version.archive_bytes,
  version.fetched_at,
  version.activated_at,
  version.effective_from,
  version.effective_until,
  version.previous_feed_version_id,
  version.import_report
FROM gtfs_static.feed_version AS version
JOIN core.network AS network ON network.id = version.network_id
WHERE version.status = 'active';

REVOKE ALL ON ALL TABLES IN SCHEMA core, gtfs_static FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA core, gtfs_static FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA gtfs_static FROM PUBLIC;

GRANT SELECT ON ALL TABLES IN SCHEMA core, gtfs_static TO atodotren_ingest_writer;
GRANT INSERT, UPDATE ON core.station, core.line, core.branch, core.service_pattern,
  core.service_pattern_stop, core.segment TO atodotren_ingest_writer;
GRANT INSERT, UPDATE ON gtfs_static.feed_version TO atodotren_ingest_writer;
GRANT INSERT ON gtfs_static.stop, gtfs_static.route, gtfs_static.calendar_service,
  gtfs_static.calendar_exception, gtfs_static.shape, gtfs_static.shape_point, gtfs_static.trip,
  gtfs_static.stop_time, gtfs_static.stop_station_map, gtfs_static.route_line_map,
  gtfs_static.trip_pattern_map TO atodotren_ingest_writer;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core, gtfs_static TO atodotren_ingest_writer;
GRANT EXECUTE ON FUNCTION gtfs_static.analyze_static_tables() TO atodotren_ingest_writer;

GRANT SELECT ON ALL TABLES IN SCHEMA core, gtfs_static TO atodotren_backup_reader;
GRANT SELECT ON gtfs_static.current_feed_version TO atodotren_monitor_reader;
GRANT USAGE ON SCHEMA gtfs_static TO atodotren_monitor_reader;

ALTER DEFAULT PRIVILEGES FOR ROLE atodotren_migration_admin IN SCHEMA core, gtfs_static
  REVOKE ALL ON TABLES FROM atodotren_ingest_writer;
ALTER DEFAULT PRIVILEGES FOR ROLE atodotren_migration_admin IN SCHEMA core, gtfs_static
  REVOKE ALL ON SEQUENCES FROM atodotren_ingest_writer;
