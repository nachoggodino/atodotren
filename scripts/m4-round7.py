from pathlib import Path

migration = Path('migrations/0006_aggregation_retention.sql')
sql = migration.read_text()
old = """  IF p_retention_family = 'canonical_detail' THEN
    EXECUTE format('DROP TABLE core.%I', 'journey_stop_' || to_char(p_target_date, 'YYYYMMDD'));
    EXECUTE format('DROP TABLE core.%I', 'journey_' || to_char(p_target_date, 'YYYYMMDD'));
  ELSE
"""
new = """  IF p_retention_family = 'canonical_detail' THEN
    -- The stop partition must leave the referencing side first. Dropping a
    -- referenced journey partition directly would otherwise require CASCADE
    -- because PostgreSQL tracks partition-aware foreign-key dependencies.
    EXECUTE format(
      'ALTER TABLE core.journey_stop DETACH PARTITION core.%I',
      'journey_stop_' || to_char(p_target_date, 'YYYYMMDD')
    );
    EXECUTE format('DROP TABLE core.%I', 'journey_stop_' || to_char(p_target_date, 'YYYYMMDD'));
    EXECUTE format(
      'ALTER TABLE core.journey DETACH PARTITION core.%I',
      'journey_' || to_char(p_target_date, 'YYYYMMDD')
    );
    EXECUTE format('DROP TABLE core.%I', 'journey_' || to_char(p_target_date, 'YYYYMMDD'));
  ELSE
"""
if new not in sql:
    if old not in sql:
        raise SystemExit('canonical retention drop anchor missing')
    sql = sql.replace(old, new, 1)
migration.write_text(sql)
