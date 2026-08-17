-- Prevent versioned static mappings and feed-version fallback links from crossing networks.

SET LOCAL ROLE atodotren_migration_admin;

DO $validation$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM gtfs_static.stop_station_map AS mapping
    JOIN gtfs_static.feed_version AS version ON version.id = mapping.feed_version_id
    JOIN core.station AS station ON station.id = mapping.station_id
    WHERE station.network_id <> version.network_id
  ) OR EXISTS (
    SELECT 1
    FROM gtfs_static.route_line_map AS mapping
    JOIN gtfs_static.feed_version AS version ON version.id = mapping.feed_version_id
    JOIN core.line AS line ON line.id = mapping.line_id
    WHERE line.network_id <> version.network_id
  ) OR EXISTS (
    SELECT 1
    FROM gtfs_static.trip_pattern_map AS mapping
    JOIN gtfs_static.feed_version AS version ON version.id = mapping.feed_version_id
    JOIN core.branch AS branch ON branch.id = mapping.branch_id
    JOIN core.line AS branch_line ON branch_line.id = branch.line_id
    JOIN core.service_pattern AS pattern ON pattern.id = mapping.service_pattern_id
    JOIN core.branch AS pattern_branch ON pattern_branch.id = pattern.branch_id
    JOIN core.line AS pattern_line ON pattern_line.id = pattern_branch.line_id
    WHERE pattern.branch_id <> mapping.branch_id
       OR branch_line.network_id <> version.network_id
       OR pattern_line.network_id <> version.network_id
  ) THEN
    RAISE EXCEPTION 'Existing static mappings violate network or branch integrity';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM gtfs_static.feed_version AS version
    JOIN gtfs_static.feed_version AS previous ON previous.id = version.previous_feed_version_id
    WHERE previous.network_id <> version.network_id
       OR previous.status NOT IN ('active', 'superseded')
  ) THEN
    RAISE EXCEPTION 'Existing feed-version fallback links violate network or lifecycle integrity';
  END IF;
END
$validation$;

CREATE OR REPLACE FUNCTION gtfs_static.guard_mapping_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  feed_network_id bigint;
  stable_network_id bigint;
  pattern_network_id bigint;
  pattern_branch_id bigint;
BEGIN
  SELECT network_id INTO feed_network_id
  FROM gtfs_static.feed_version
  WHERE id = NEW.feed_version_id;

  IF TG_TABLE_NAME = 'stop_station_map' THEN
    SELECT network_id INTO stable_network_id FROM core.station WHERE id = NEW.station_id;
  ELSIF TG_TABLE_NAME = 'route_line_map' THEN
    SELECT network_id INTO stable_network_id FROM core.line WHERE id = NEW.line_id;
  ELSE
    SELECT line.network_id INTO stable_network_id
    FROM core.branch AS branch
    JOIN core.line AS line ON line.id = branch.line_id
    WHERE branch.id = NEW.branch_id;

    SELECT pattern.branch_id, line.network_id INTO pattern_branch_id, pattern_network_id
    FROM core.service_pattern AS pattern
    JOIN core.branch AS branch ON branch.id = pattern.branch_id
    JOIN core.line AS line ON line.id = branch.line_id
    WHERE pattern.id = NEW.service_pattern_id;

    IF pattern_branch_id IS DISTINCT FROM NEW.branch_id THEN
      RAISE EXCEPTION 'Trip branch and service pattern must agree';
    END IF;
    IF pattern_network_id IS DISTINCT FROM feed_network_id THEN
      RAISE EXCEPTION 'Mapped service pattern must belong to the feed network';
    END IF;
  END IF;

  IF stable_network_id IS DISTINCT FROM feed_network_id THEN
    RAISE EXCEPTION 'Static mapping must remain within the feed network';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER mapping_integrity_guard
BEFORE INSERT OR UPDATE ON gtfs_static.stop_station_map
FOR EACH ROW EXECUTE FUNCTION gtfs_static.guard_mapping_integrity();

CREATE TRIGGER mapping_integrity_guard
BEFORE INSERT OR UPDATE ON gtfs_static.route_line_map
FOR EACH ROW EXECUTE FUNCTION gtfs_static.guard_mapping_integrity();

CREATE TRIGGER mapping_integrity_guard
BEFORE INSERT OR UPDATE ON gtfs_static.trip_pattern_map
FOR EACH ROW EXECUTE FUNCTION gtfs_static.guard_mapping_integrity();

CREATE OR REPLACE FUNCTION gtfs_static.guard_previous_feed_version()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  previous_network_id bigint;
  previous_status text;
BEGIN
  IF NEW.previous_feed_version_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT network_id, status INTO previous_network_id, previous_status
  FROM gtfs_static.feed_version
  WHERE id = NEW.previous_feed_version_id;

  IF previous_network_id IS DISTINCT FROM NEW.network_id THEN
    RAISE EXCEPTION 'Previous feed version must belong to the same network';
  END IF;
  IF previous_status NOT IN ('active', 'superseded') THEN
    RAISE EXCEPTION 'Previous feed version must be a successful active or superseded version';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER feed_version_previous_integrity_guard
BEFORE INSERT OR UPDATE OF previous_feed_version_id, network_id ON gtfs_static.feed_version
FOR EACH ROW EXECUTE FUNCTION gtfs_static.guard_previous_feed_version();

REVOKE ALL ON FUNCTION gtfs_static.guard_mapping_integrity() FROM PUBLIC;
REVOKE ALL ON FUNCTION gtfs_static.guard_previous_feed_version() FROM PUBLIC;
