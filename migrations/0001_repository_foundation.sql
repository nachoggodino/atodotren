-- Atodotren Milestone 0 database foundation.
-- Cluster roles and migration-login membership are bootstrapped separately.
-- Application data belongs only in the private schemas created here.

DO $roles$
DECLARE
  required_role name;
  existing pg_roles%ROWTYPE;
BEGIN
  FOREACH required_role IN ARRAY ARRAY[
    'atodotren_migration_admin',
    'atodotren_ingest_writer',
    'atodotren_web_reader',
    'atodotren_backup_reader',
    'atodotren_monitor_reader'
  ]::name[]
  LOOP
    SELECT * INTO existing FROM pg_roles WHERE rolname = required_role;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Required role % is missing; run the database role bootstrap first', required_role;
    ELSIF existing.rolcanlogin
      OR existing.rolsuper
      OR existing.rolcreatedb
      OR existing.rolcreaterole
      OR existing.rolreplication
      OR existing.rolbypassrls
    THEN
      RAISE EXCEPTION 'Required role % has unsafe attributes', required_role;
    END IF;
  END LOOP;
END
$roles$;

DO $migration_membership$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
    JOIN pg_roles member_role ON member_role.oid = membership.member
    WHERE granted_role.rolname = 'atodotren_migration_admin'
      AND member_role.rolname = session_user
      AND NOT membership.admin_option
      AND NOT membership.inherit_option
      AND membership.set_option
  ) THEN
    RAISE EXCEPTION
      'Migration login % needs atodotren_migration_admin membership with ADMIN FALSE, INHERIT FALSE, SET TRUE',
      session_user;
  END IF;
END
$migration_membership$;

SET LOCAL ROLE atodotren_migration_admin;

CREATE SCHEMA IF NOT EXISTS gtfs_static AUTHORIZATION atodotren_migration_admin;
CREATE SCHEMA IF NOT EXISTS ingest AUTHORIZATION atodotren_migration_admin;
CREATE SCHEMA IF NOT EXISTS core AUTHORIZATION atodotren_migration_admin;
CREATE SCHEMA IF NOT EXISTS analytics AUTHORIZATION atodotren_migration_admin;
CREATE SCHEMA IF NOT EXISTS api AUTHORIZATION atodotren_migration_admin;
CREATE SCHEMA IF NOT EXISTS operations AUTHORIZATION atodotren_migration_admin;

REVOKE ALL ON SCHEMA gtfs_static, ingest, core, analytics, api, operations FROM PUBLIC;

GRANT USAGE ON SCHEMA gtfs_static, ingest, core, analytics, operations TO atodotren_ingest_writer;
GRANT USAGE ON SCHEMA api TO atodotren_web_reader;
GRANT USAGE ON SCHEMA gtfs_static, ingest, core, analytics, api, operations TO atodotren_backup_reader;
GRANT USAGE ON SCHEMA operations TO atodotren_monitor_reader;

CREATE TABLE IF NOT EXISTS operations.schema_migration (
  name text PRIMARY KEY,
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_by name NOT NULL DEFAULT session_user
);

CREATE OR REPLACE VIEW operations.database_health
WITH (security_invoker = true)
AS
SELECT
  clock_timestamp() AS checked_at,
  current_database() AS database_name,
  current_user AS database_user,
  current_setting('server_version') AS server_version,
  pg_is_in_recovery() AS in_recovery;

REVOKE ALL ON ALL TABLES IN SCHEMA gtfs_static, ingest, core, analytics, api, operations FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA gtfs_static, ingest, core, analytics, api, operations FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA gtfs_static, ingest, core, analytics, api, operations FROM PUBLIC;

GRANT SELECT ON operations.schema_migration, operations.database_health TO atodotren_ingest_writer;
GRANT SELECT ON operations.schema_migration, operations.database_health TO atodotren_backup_reader;
GRANT SELECT ON operations.database_health TO atodotren_monitor_reader;

ALTER DEFAULT PRIVILEGES FOR ROLE atodotren_migration_admin
  IN SCHEMA api
  GRANT SELECT ON TABLES TO atodotren_web_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE atodotren_migration_admin
  IN SCHEMA gtfs_static, ingest, core, analytics, api, operations
  GRANT SELECT ON TABLES TO atodotren_backup_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE atodotren_migration_admin
  IN SCHEMA gtfs_static, ingest, core, analytics, api, operations
  GRANT SELECT ON SEQUENCES TO atodotren_backup_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE atodotren_migration_admin
  IN SCHEMA gtfs_static, ingest, core, analytics, api, operations
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
