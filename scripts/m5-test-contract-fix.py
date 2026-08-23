from pathlib import Path

path = Path('tests/unit/database-contract.test.ts')
text = path.read_text()
old = """  const [migration, bootstrap] = await Promise.all([
    readFile('migrations/0001_repository_foundation.sql', 'utf8'),
    readFile('docker/postgres/init/001-runtime-roles.sh', 'utf8'),
  ]);"""
new = """  const [foundationMigration, reportingMigration, bootstrap] = await Promise.all([
    readFile('migrations/0001_repository_foundation.sql', 'utf8'),
    readFile('migrations/0009_reporting_telegram.sql', 'utf8'),
    readFile('docker/postgres/init/001-runtime-roles.sh', 'utf8'),
  ]);
  const migration = `${foundationMigration}\n${reportingMigration}`;"""
if old not in text:
    raise SystemExit('database contract fixture target missing')
path.write_text(text.replace(old, new))
