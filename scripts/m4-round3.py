from pathlib import Path

migration = Path('migrations/0006_aggregation_retention.sql')
sql = migration.read_text()
old = """  UPDATE operations.retention_ledger
  SET revoked_at = clock_timestamp()
  WHERE family = 'canonical_detail' AND target_date = analytics.mark_dirty.target_date
    AND applied_at IS NULL AND revoked_at IS NULL;
"""
new = """  UPDATE operations.retention_ledger AS ledger
  SET revoked_at = clock_timestamp()
  WHERE ledger.family = 'canonical_detail'
    AND ledger.target_date = analytics.mark_dirty.target_date
    AND ledger.applied_at IS NULL AND ledger.revoked_at IS NULL;
"""
if new not in sql:
    if old not in sql:
        raise SystemExit('qualified retention ledger update anchor missing')
    sql = sql.replace(old, new, 1)
migration.write_text(sql)

acceptance = Path('tests/integration/milestone4.test.ts')
text = acceptance.read_text()
text = text.replace(
    "const histogramLaw = await pool.query<{ associative: boolean; underflow: number; overflow: number }>(`",
    "const histogramLaw = await databaseAdmin.query<{ associative: boolean; underflow: number; overflow: number }>(`",
    1,
)
acceptance.write_text(text)
