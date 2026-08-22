from pathlib import Path

migration = Path('migrations/0006_aggregation_retention.sql')
sql = migration.read_text()

authorize_old = """CREATE OR REPLACE FUNCTION operations.authorize_retention_partition(
  retention_family text,
  target_date date,
  as_of timestamptz,
  algorithm_version text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, operations, analytics
AS $function$
DECLARE
  candidate record;
  finalization operations.service_day_finalization%ROWTYPE;
  verification_id_value bigint;
  aggregate_checksum_value text;
  authorization_checksum_value text;
  ledger_id bigint;
  remaining_blockers text[];
BEGIN
  SELECT candidate_row.* INTO candidate
  FROM operations.retention_candidates(as_of, algorithm_version) AS candidate_row
  WHERE candidate_row.family = retention_family
    AND candidate_row.target_date = authorize_retention_partition.target_date;
  IF NOT FOUND THEN RAISE EXCEPTION 'No known retention candidate % for %', retention_family, target_date; END IF;
  remaining_blockers := array_remove(candidate.blockers, 'authorization_missing');
  IF cardinality(remaining_blockers) > 0 THEN
    RAISE EXCEPTION 'Retention authorization blocked for % %: %', retention_family, target_date, remaining_blockers;
  END IF;
  IF retention_family = 'canonical_detail' THEN
    SELECT * INTO finalization FROM operations.service_day_finalization
    WHERE service_date = target_date AND aggregate_algorithm_version = algorithm_version AND status = 'verified';
    verification_id_value := finalization.verification_id;
    aggregate_checksum_value := finalization.aggregate_checksum;
  ELSE
    verification_id_value := NULL; aggregate_checksum_value := NULL;
  END IF;
  authorization_checksum_value := encode(sha256(convert_to(
    retention_family || '|' || target_date::text || '|' || array_to_string(candidate.partition_names, ',') || '|' ||
    candidate.source_rows || '|' || candidate.source_checksum || '|' || COALESCE(aggregate_checksum_value, '') || '|' || algorithm_version,
    'UTF8')), 'hex');
  INSERT INTO operations.retention_ledger (
    family, target_date, partition_names, aggregate_algorithm_version,
    source_row_count, source_checksum, aggregate_checksum, verification_id, authorization_checksum
  ) VALUES (
    retention_family, target_date, candidate.partition_names, algorithm_version,
    candidate.source_rows, candidate.source_checksum, aggregate_checksum_value,
    verification_id_value, authorization_checksum_value
  ) ON CONFLICT (family, target_date, aggregate_algorithm_version, authorization_checksum)
    DO UPDATE SET authorized_at = clock_timestamp(), revoked_at = NULL
  RETURNING id INTO ledger_id;
  RETURN ledger_id;
END
$function$;
"""
authorize_new = """CREATE OR REPLACE FUNCTION operations.authorize_retention_partition(
  p_retention_family text,
  p_target_date date,
  p_as_of timestamptz,
  p_algorithm_version text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, operations, analytics
AS $function$
DECLARE
  candidate record;
  finalization operations.service_day_finalization%ROWTYPE;
  verification_id_value bigint;
  aggregate_checksum_value text;
  authorization_checksum_value text;
  ledger_id bigint;
  remaining_blockers text[];
BEGIN
  SELECT candidate_row.* INTO candidate
  FROM operations.retention_candidates(p_as_of, p_algorithm_version) AS candidate_row
  WHERE candidate_row.family = p_retention_family
    AND candidate_row.target_date = p_target_date;
  IF NOT FOUND THEN RAISE EXCEPTION 'No known retention candidate % for %', p_retention_family, p_target_date; END IF;
  remaining_blockers := array_remove(candidate.blockers, 'authorization_missing');
  IF cardinality(remaining_blockers) > 0 THEN
    RAISE EXCEPTION 'Retention authorization blocked for % %: %', p_retention_family, p_target_date, remaining_blockers;
  END IF;
  IF p_retention_family = 'canonical_detail' THEN
    SELECT * INTO finalization FROM operations.service_day_finalization
    WHERE service_date = p_target_date
      AND aggregate_algorithm_version = p_algorithm_version
      AND status = 'verified';
    verification_id_value := finalization.verification_id;
    aggregate_checksum_value := finalization.aggregate_checksum;
  ELSE
    verification_id_value := NULL; aggregate_checksum_value := NULL;
  END IF;
  authorization_checksum_value := encode(sha256(convert_to(
    p_retention_family || '|' || p_target_date::text || '|' || array_to_string(candidate.partition_names, ',') || '|' ||
    candidate.source_rows || '|' || candidate.source_checksum || '|' || COALESCE(aggregate_checksum_value, '') || '|' || p_algorithm_version,
    'UTF8')), 'hex');
  INSERT INTO operations.retention_ledger (
    family, target_date, partition_names, aggregate_algorithm_version,
    source_row_count, source_checksum, aggregate_checksum, verification_id, authorization_checksum
  ) VALUES (
    p_retention_family, p_target_date, candidate.partition_names, p_algorithm_version,
    candidate.source_rows, candidate.source_checksum, aggregate_checksum_value,
    verification_id_value, authorization_checksum_value
  ) ON CONFLICT (family, target_date, aggregate_algorithm_version, authorization_checksum)
    DO UPDATE SET authorized_at = clock_timestamp(), revoked_at = NULL
  RETURNING id INTO ledger_id;
  RETURN ledger_id;
END
$function$;
"""

if authorize_new not in sql:
    if authorize_old not in sql:
        raise SystemExit('authorize_retention_partition anchor missing')
    sql = sql.replace(authorize_old, authorize_new, 1)

drop_old = """CREATE OR REPLACE FUNCTION operations.drop_retention_partition(
  retention_family text,
  target_date date,
  as_of timestamptz,
  algorithm_version text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, operations, analytics, core, ingest
AS $function$
DECLARE
  candidate record;
  ledger operations.retention_ledger%ROWTYPE;
  dropped_rows bigint;
  partition_name text;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('retention:' || retention_family || ':' || target_date::text, 0)) THEN
    RETURN jsonb_build_object('status', 'locked', 'family', retention_family, 'targetDate', target_date);
  END IF;
  SELECT candidate_row.* INTO candidate
  FROM operations.retention_candidates(as_of, algorithm_version) AS candidate_row
  WHERE candidate_row.family = retention_family
    AND candidate_row.target_date = drop_retention_partition.target_date;
  IF NOT FOUND THEN RAISE EXCEPTION 'No known retention candidate % for %', retention_family, target_date; END IF;
  IF cardinality(candidate.blockers) > 0 THEN
    RAISE EXCEPTION 'Retention drop blocked for % %: %', retention_family, target_date, candidate.blockers;
  END IF;
  SELECT retention.* INTO ledger
  FROM operations.retention_ledger AS retention
  WHERE retention.family = retention_family
    AND retention.target_date = drop_retention_partition.target_date
    AND retention.aggregate_algorithm_version = algorithm_version
    AND retention.source_checksum = candidate.source_checksum
    AND retention.applied_at IS NULL AND retention.revoked_at IS NULL
  ORDER BY retention.authorized_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Authorizing retention ledger entry is required'; END IF;
  dropped_rows := ledger.source_row_count;

  IF retention_family = 'canonical_detail' THEN
    EXECUTE format('DROP TABLE core.%I', 'journey_stop_' || to_char(target_date, 'YYYYMMDD'));
    EXECUTE format('DROP TABLE core.%I', 'journey_' || to_char(target_date, 'YYYYMMDD'));
  ELSE
    partition_name := retention_family || '_' || to_char(target_date, 'YYYYMMDD');
    EXECUTE format('DROP TABLE ingest.%I', partition_name);
  END IF;
  UPDATE operations.retention_ledger
  SET applied_at = clock_timestamp(), dropped_row_count = dropped_rows
  WHERE id = ledger.id;
  RETURN jsonb_build_object(
    'status', 'dropped', 'family', retention_family, 'targetDate', target_date,
    'partitionNames', to_jsonb(ledger.partition_names), 'droppedRows', dropped_rows
  );
END
$function$;
"""
drop_new = """CREATE OR REPLACE FUNCTION operations.drop_retention_partition(
  p_retention_family text,
  p_target_date date,
  p_as_of timestamptz,
  p_algorithm_version text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, operations, analytics, core, ingest
AS $function$
DECLARE
  candidate record;
  ledger operations.retention_ledger%ROWTYPE;
  dropped_rows bigint;
  partition_name text;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('retention:' || p_retention_family || ':' || p_target_date::text, 0)) THEN
    RETURN jsonb_build_object('status', 'locked', 'family', p_retention_family, 'targetDate', p_target_date);
  END IF;
  SELECT candidate_row.* INTO candidate
  FROM operations.retention_candidates(p_as_of, p_algorithm_version) AS candidate_row
  WHERE candidate_row.family = p_retention_family
    AND candidate_row.target_date = p_target_date;
  IF NOT FOUND THEN RAISE EXCEPTION 'No known retention candidate % for %', p_retention_family, p_target_date; END IF;
  IF cardinality(candidate.blockers) > 0 THEN
    RAISE EXCEPTION 'Retention drop blocked for % %: %', p_retention_family, p_target_date, candidate.blockers;
  END IF;
  SELECT retention.* INTO ledger
  FROM operations.retention_ledger AS retention
  WHERE retention.family = p_retention_family
    AND retention.target_date = p_target_date
    AND retention.aggregate_algorithm_version = p_algorithm_version
    AND retention.source_checksum = candidate.source_checksum
    AND retention.applied_at IS NULL AND retention.revoked_at IS NULL
  ORDER BY retention.authorized_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Authorizing retention ledger entry is required'; END IF;
  dropped_rows := ledger.source_row_count;

  IF p_retention_family = 'canonical_detail' THEN
    EXECUTE format('DROP TABLE core.%I', 'journey_stop_' || to_char(p_target_date, 'YYYYMMDD'));
    EXECUTE format('DROP TABLE core.%I', 'journey_' || to_char(p_target_date, 'YYYYMMDD'));
  ELSE
    partition_name := p_retention_family || '_' || to_char(p_target_date, 'YYYYMMDD');
    EXECUTE format('DROP TABLE ingest.%I', partition_name);
  END IF;
  UPDATE operations.retention_ledger
  SET applied_at = clock_timestamp(), dropped_row_count = dropped_rows
  WHERE id = ledger.id;
  RETURN jsonb_build_object(
    'status', 'dropped', 'family', p_retention_family, 'targetDate', p_target_date,
    'partitionNames', to_jsonb(ledger.partition_names), 'droppedRows', dropped_rows
  );
END
$function$;
"""

if drop_new not in sql:
    if drop_old not in sql:
        raise SystemExit('drop_retention_partition anchor missing')
    sql = sql.replace(drop_old, drop_new, 1)

migration.write_text(sql)
