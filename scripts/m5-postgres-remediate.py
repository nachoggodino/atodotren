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
migration.write_text(text.replace(needle, addition))

# Milestone 4 acceptance remains behaviorally unchanged but runs the repository's
# complete additive migration inventory.
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

list_needle = """        '0007_m4_correctness_gates.sql',
        '0008_timetable_metric_identity.sql',
      ]);"""
list_replacement = """        '0007_m4_correctness_gates.sql',
        '0008_timetable_metric_identity.sql',
        '0009_reporting_telegram.sql',
      ]);"""
if text.count(list_needle) != 2:
    raise SystemExit(f'expected two current migration inventory assertions, found {text.count(list_needle)}')
text = text.replace(list_needle, list_replacement)
postgres.write_text(text)
