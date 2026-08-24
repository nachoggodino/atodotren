-- Frontend alpha: explicit least-privilege grants for the public web login group.
-- The login itself is bootstrapped outside migrations because credentials never belong in SQL files.

SET LOCAL ROLE atodotren_migration_admin;

DO $web_role$
DECLARE
  existing pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO existing FROM pg_roles WHERE rolname = 'atodotren_web_reader';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Required role atodotren_web_reader is missing; run the database role bootstrap first';
  ELSIF existing.rolcanlogin
    OR existing.rolsuper
    OR existing.rolcreatedb
    OR existing.rolcreaterole
    OR existing.rolreplication
    OR existing.rolbypassrls
  THEN
    RAISE EXCEPTION 'Required role atodotren_web_reader has unsafe attributes';
  END IF;
END
$web_role$;

GRANT USAGE ON SCHEMA api TO atodotren_web_reader;
REVOKE ALL ON ALL TABLES IN SCHEMA api FROM atodotren_web_reader;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA api FROM atodotren_web_reader;

GRANT SELECT ON
  api.line_catalog,
  api.station_catalog,
  api.live_vehicle,
  api.schematic_pattern_stop,
  api.history_network_day,
  api.history_line_day,
  api.history_line_hour,
  api.history_station_hour,
  api.service_day_state
TO atodotren_web_reader;

GRANT EXECUTE ON FUNCTION api.catalog_search(text, integer),
  api.recent_line_matrix(text, date, integer),
  api.recent_journey(date, bigint)
TO atodotren_web_reader;

-- normalize_search is an implementation detail invoked through SECURITY DEFINER search.
REVOKE ALL ON FUNCTION api.normalize_search(text) FROM atodotren_web_reader;

-- Keep future API objects deny-by-default. New public objects require a migration with an explicit grant.
ALTER DEFAULT PRIVILEGES FOR ROLE atodotren_migration_admin IN SCHEMA api
  REVOKE SELECT ON TABLES FROM atodotren_web_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE atodotren_migration_admin IN SCHEMA api
  REVOKE EXECUTE ON FUNCTIONS FROM atodotren_web_reader;
