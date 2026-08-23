from pathlib import Path


def replace(path_name: str, old: str, new: str, count: int | None = None) -> None:
    path = Path(path_name)
    text = path.read_text()
    found = text.count(old)
    expected = count if count is not None else 1
    if found != expected:
        raise SystemExit(f'{path_name}: expected {expected} occurrence(s), found {found}: {old[:100]!r}')
    path.write_text(text.replace(old, new))


# Approved reporting views aggregate retained histogram arrays. PostgreSQL checks
# EXECUTE on aggregate functions for the calling role, so expose only the exact
# routines required by those views; do not grant SELECT on analytics base tables.
migration = Path('migrations/0009_reporting_telegram.sql')
text = migration.read_text()
needle = "GRANT USAGE ON SCHEMA operations TO atodotren_reporting_reader;\n"
addition = """GRANT USAGE ON SCHEMA operations TO atodotren_reporting_reader;
GRANT USAGE ON SCHEMA analytics TO atodotren_reporting_reader;
GRANT EXECUTE ON FUNCTION analytics.histogram_add(integer[], integer[]),
  analytics.histogram_sum(integer[])
TO atodotren_reporting_reader;
"""
if text.count(needle) != 1:
    raise SystemExit('0009 reporting schema grant target missing or duplicated')
text = text.replace(needle, addition)

# Do not wrap older security-invoker health views. Build approved report views
# directly over their facts so the view owner mediates read-only access without
# granting Telegram direct access to ingestion/canonical tables.
ingest_view_old = """CREATE OR REPLACE VIEW operations.report_ingest_health
WITH (security_barrier = true)
AS
SELECT
  last_durable_cycle_at,
  last_postgres_cycle_at,
  consecutive_failures,
  spool_pending_count,
  spool_bytes,
  spool_dropped_count,
  updated_at,
  latest_successful_poll_at,
  live_vehicle_count,
  open_incident_count
FROM operations.realtime_health;
"""
ingest_view_new = """CREATE OR REPLACE VIEW operations.report_ingest_health
WITH (security_barrier = true)
AS
SELECT
  health.last_durable_cycle_at,
  health.last_postgres_cycle_at,
  health.consecutive_failures,
  health.spool_pending_count,
  health.spool_bytes,
  health.spool_dropped_count,
  health.updated_at,
  (SELECT max(poll.captured_at) FROM ingest.poll_run AS poll WHERE poll.result_class = 'success') AS latest_successful_poll_at,
  (SELECT count(*) FROM ingest.live_vehicle_state) AS live_vehicle_count,
  (SELECT count(*) FROM operations.notification_incident AS incident WHERE incident.is_open) AS open_incident_count
FROM operations.ingest_health AS health;
"""
if text.count(ingest_view_old) != 1:
    raise SystemExit('report_ingest_health target missing or duplicated')
text = text.replace(ingest_view_old, ingest_view_new)

canonical_view_old = """CREATE OR REPLACE VIEW operations.report_canonical_health
WITH (security_barrier = true)
AS SELECT * FROM operations.canonical_health;
"""
canonical_view_new = """CREATE OR REPLACE VIEW operations.report_canonical_health
WITH (security_barrier = true)
AS
SELECT
  count(*) FILTER (WHERE journey.finalized_at IS NULL) AS open_journeys,
  count(*) FILTER (WHERE journey.finalized_at IS NOT NULL) AS closed_journeys,
  min(journey.scheduled_end_at) FILTER (WHERE journey.finalized_at IS NULL) AS oldest_open_scheduled_end_at,
  max(journey.updated_at) AS latest_canonical_update_at
FROM core.journey AS journey;
"""
if text.count(canonical_view_old) != 1:
    raise SystemExit('report_canonical_health target missing or duplicated')
text = text.replace(canonical_view_old, canonical_view_new)
migration.write_text(text)

replace(
    'tests/integration/milestone4.test.ts',
    "assert.equal(migrated.applied.at(-1), '0008_timetable_metric_identity.sql');",
    "assert.equal(migrated.applied.at(-1), '0009_reporting_telegram.sql');",
)

postgres = Path('tests/integration/postgres.test.ts')
text = postgres.read_text()
copy_needle = """    cp(
      resolve(process.cwd(), 'migrations/0008_timetable_metric_identity.sql'),
      join(directory, '0008_timetable_metric_identity.sql'),
    ),
"""
copy_addition = copy_needle + """    cp(
      resolve(process.cwd(), 'migrations/0009_reporting_telegram.sql'),
      join(directory, '0009_reporting_telegram.sql'),
    ),
"""
if text.count(copy_needle) != 1:
    raise SystemExit('copyCurrentMigrations 0008 target missing or duplicated')
text = text.replace(copy_needle, copy_addition)

standard_list = """        '0007_m4_correctness_gates.sql',
        '0008_timetable_metric_identity.sql',
      ]);"""
standard_replacement = """        '0007_m4_correctness_gates.sql',
        '0008_timetable_metric_identity.sql',
        '0009_reporting_telegram.sql',
      ]);"""
if text.count(standard_list) != 2:
    raise SystemExit(f'expected two standard current migration inventories, found {text.count(standard_list)}')
text = text.replace(standard_list, standard_replacement)

rotated_list = """          '0007_m4_correctness_gates.sql',
          '0008_timetable_metric_identity.sql',
        ]);"""
rotated_replacement = """          '0007_m4_correctness_gates.sql',
          '0008_timetable_metric_identity.sql',
          '0009_reporting_telegram.sql',
        ]);"""
if text.count(rotated_list) != 1:
    raise SystemExit(f'expected one rotated migration inventory, found {text.count(rotated_list)}')
text = text.replace(rotated_list, rotated_replacement)
postgres.write_text(text)

# Close Telegram test connections before outer database teardown. t.after executes
# after the outer finally and would otherwise observe administrator termination.
m5 = Path('tests/integration/milestone5.test.ts')
text = m5.read_text()
after_block = """    t.after(async () => {
      await telegram.end().catch(() => undefined);
      await telegram2.end().catch(() => undefined);
    });

"""
if text.count(after_block) != 1:
    raise SystemExit('Milestone 5 delayed connection cleanup target missing')
text = text.replace(after_block, '')
last_subtest_end = """      } finally {
        await databaseAdmin.end();
      }
    });
  } finally {
"""
replacement_end = """      } finally {
        await databaseAdmin.end();
      }
    });

    await telegram.end();
    await telegram2.end();
  } finally {
"""
if text.count(last_subtest_end) != 1:
    raise SystemExit('Milestone 5 connection close insertion target missing')
text = text.replace(last_subtest_end, replacement_end)
m5.write_text(text)
