#!/usr/bin/env bash
set -Eeuo pipefail

: "${ATODOTREN_WORKER_PASSWORD:?ATODOTREN_WORKER_PASSWORD is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"

psql --set=ON_ERROR_STOP=1 \
  --set=worker_password="${ATODOTREN_WORKER_PASSWORD}" \
  --set=migrator_password="${POSTGRES_PASSWORD}" \
  --set=database_name="${POSTGRES_DB}" \
  --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" <<'SQL'
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
      EXECUTE format(
        'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
        required_role
      );
    ELSIF existing.rolcanlogin
      OR existing.rolsuper
      OR existing.rolcreatedb
      OR existing.rolcreaterole
      OR existing.rolreplication
      OR existing.rolbypassrls
    THEN
      RAISE EXCEPTION 'Existing role % has unsafe attributes', required_role;
    END IF;
  END LOOP;
END
$roles$;

SELECT format(
  'CREATE ROLE atodotren_worker LOGIN INHERIT PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'worker_password'
) WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'atodotren_worker') \gexec

SELECT format(
  'CREATE ROLE atodotren_migrator LOGIN NOINHERIT PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'migrator_password'
) WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'atodotren_migrator') \gexec

DO $logins$
DECLARE
  login_role name;
  existing pg_roles%ROWTYPE;
BEGIN
  FOREACH login_role IN ARRAY ARRAY['atodotren_worker', 'atodotren_migrator']::name[]
  LOOP
    SELECT * INTO STRICT existing FROM pg_roles WHERE rolname = login_role;
    IF NOT existing.rolcanlogin
      OR existing.rolsuper
      OR existing.rolcreatedb
      OR existing.rolcreaterole
      OR existing.rolreplication
      OR existing.rolbypassrls
      OR (login_role = 'atodotren_worker' AND NOT existing.rolinherit)
      OR (login_role = 'atodotren_migrator' AND existing.rolinherit)
    THEN
      RAISE EXCEPTION 'Existing login role % has unsafe attributes', login_role;
    END IF;
  END LOOP;
END
$logins$;

GRANT atodotren_ingest_writer TO atodotren_worker
  WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
GRANT atodotren_migration_admin TO atodotren_migrator
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;

DO $membership_contract$
DECLARE
  direct_count integer;
  exact_count integer;
BEGIN
  SELECT count(*), count(*) FILTER (
    WHERE granted_role.rolname = 'atodotren_ingest_writer'
      AND NOT membership.admin_option
      AND membership.inherit_option
      AND NOT membership.set_option
  )
  INTO direct_count, exact_count
  FROM pg_auth_members AS membership
  JOIN pg_roles AS member_role ON member_role.oid = membership.member
  JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
  WHERE member_role.rolname = 'atodotren_worker';
  IF direct_count <> 1 OR exact_count <> 1 THEN
    RAISE EXCEPTION 'atodotren_worker must have only the exact ingest-writer membership';
  END IF;

  SELECT count(*), count(*) FILTER (
    WHERE granted_role.rolname = 'atodotren_migration_admin'
      AND NOT membership.admin_option
      AND NOT membership.inherit_option
      AND membership.set_option
  )
  INTO direct_count, exact_count
  FROM pg_auth_members AS membership
  JOIN pg_roles AS member_role ON member_role.oid = membership.member
  JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
  WHERE member_role.rolname = 'atodotren_migrator';
  IF direct_count <> 1 OR exact_count <> 1 THEN
    RAISE EXCEPTION 'atodotren_migrator must have only the exact migration-admin membership';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_auth_members AS membership
    JOIN pg_roles AS member_role ON member_role.oid = membership.member
    WHERE member_role.rolname IN (
      'atodotren_migration_admin',
      'atodotren_ingest_writer',
      'atodotren_web_reader',
      'atodotren_backup_reader',
      'atodotren_monitor_reader'
    )
  ) THEN
    RAISE EXCEPTION 'Atodotren group roles must not reach parent roles';
  END IF;
END
$membership_contract$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT CREATE ON DATABASE :"database_name" TO atodotren_migration_admin;
SQL
