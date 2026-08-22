from pathlib import Path

migration = Path('migrations/0006_aggregation_retention.sql')
sql = migration.read_text()
old = """CREATE OR REPLACE FUNCTION analytics.mark_dirty(target_date date, dirty_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, analytics, operations
AS $function$
BEGIN
  IF target_date IS NULL OR dirty_reason IS NULL OR length(btrim(dirty_reason)) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'Dirty aggregation scope requires a service date and bounded reason';
  END IF;
  INSERT INTO analytics.dirty_scope (service_date, family, reason)
  VALUES (target_date, 'daily', dirty_reason), (target_date, 'schedule', dirty_reason)
  ON CONFLICT (service_date, family) DO UPDATE SET
    dirty_since = LEAST(analytics.dirty_scope.dirty_since, EXCLUDED.dirty_since),
    generation = analytics.dirty_scope.generation + 1,
    reason = EXCLUDED.reason;

  UPDATE operations.retention_ledger AS ledger
  SET revoked_at = clock_timestamp()
  WHERE ledger.family = 'canonical_detail'
    AND ledger.target_date = analytics.mark_dirty.target_date
    AND ledger.applied_at IS NULL AND ledger.revoked_at IS NULL;

  -- Open-month schedule contributions are replaceable. If this aggregate version
  -- has already sealed the calendar month, preserve its verification and monthly
  -- rows; a repair must then use a newer aggregate algorithm version.
  DELETE FROM analytics.daily_schedule_contribution AS contribution
  USING operations.service_day_finalization AS finalization
  WHERE contribution.service_date = analytics.mark_dirty.target_date
    AND finalization.service_date = contribution.service_date
    AND finalization.aggregate_algorithm_version = contribution.aggregate_algorithm_version
    AND NOT EXISTS (
      SELECT 1 FROM operations.month_seal AS seal
      WHERE seal.calendar_month = date_trunc('month', contribution.service_date)::date
        AND seal.aggregate_algorithm_version = contribution.aggregate_algorithm_version
        AND seal.status = 'sealed'
    );

  DELETE FROM operations.service_day_finalization AS finalization
  WHERE finalization.service_date = analytics.mark_dirty.target_date
    AND NOT EXISTS (
      SELECT 1 FROM operations.month_seal AS seal
      WHERE seal.calendar_month = date_trunc('month', finalization.service_date)::date
        AND seal.aggregate_algorithm_version = finalization.aggregate_algorithm_version
        AND seal.status = 'sealed'
    );
END
$function$;
"""
new = """CREATE OR REPLACE FUNCTION analytics.mark_dirty(p_target_date date, dirty_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, analytics, operations
AS $function$
BEGIN
  IF p_target_date IS NULL OR dirty_reason IS NULL OR length(btrim(dirty_reason)) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'Dirty aggregation scope requires a service date and bounded reason';
  END IF;
  INSERT INTO analytics.dirty_scope (service_date, family, reason)
  VALUES (p_target_date, 'daily', dirty_reason), (p_target_date, 'schedule', dirty_reason)
  ON CONFLICT (service_date, family) DO UPDATE SET
    dirty_since = LEAST(analytics.dirty_scope.dirty_since, EXCLUDED.dirty_since),
    generation = analytics.dirty_scope.generation + 1,
    reason = EXCLUDED.reason;

  UPDATE operations.retention_ledger AS ledger
  SET revoked_at = clock_timestamp()
  WHERE ledger.family = 'canonical_detail'
    AND ledger.target_date = p_target_date
    AND ledger.applied_at IS NULL AND ledger.revoked_at IS NULL;

  -- Open-month schedule contributions are replaceable. If this aggregate version
  -- has already sealed the calendar month, preserve its verification and monthly
  -- rows; a repair must then use a newer aggregate algorithm version.
  DELETE FROM analytics.daily_schedule_contribution AS contribution
  USING operations.service_day_finalization AS finalization
  WHERE contribution.service_date = p_target_date
    AND finalization.service_date = contribution.service_date
    AND finalization.aggregate_algorithm_version = contribution.aggregate_algorithm_version
    AND NOT EXISTS (
      SELECT 1 FROM operations.month_seal AS seal
      WHERE seal.calendar_month = date_trunc('month', contribution.service_date)::date
        AND seal.aggregate_algorithm_version = contribution.aggregate_algorithm_version
        AND seal.status = 'sealed'
    );

  DELETE FROM operations.service_day_finalization AS finalization
  WHERE finalization.service_date = p_target_date
    AND NOT EXISTS (
      SELECT 1 FROM operations.month_seal AS seal
      WHERE seal.calendar_month = date_trunc('month', finalization.service_date)::date
        AND seal.aggregate_algorithm_version = finalization.aggregate_algorithm_version
        AND seal.status = 'sealed'
    );
END
$function$;
"""
if new not in sql:
    if old not in sql:
        raise SystemExit('current mark_dirty block anchor missing')
    sql = sql.replace(old, new, 1)
migration.write_text(sql)
