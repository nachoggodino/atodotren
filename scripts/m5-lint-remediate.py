from pathlib import Path
import re


def replace(path_name: str, old: str, new: str) -> None:
    path = Path(path_name)
    text = path.read_text()
    if old not in text:
        raise SystemExit(f'missing remediation target in {path_name}: {old[:80]!r}')
    path.write_text(text.replace(old, new))


# Type every raw pg result at its query boundary. Existing explicit row generics are preserved.
query_paths = [
    'apps/worker/src/reporting-service.ts',
    'apps/worker/src/reporting-operations.ts',
    'apps/worker/src/resources.ts',
    'apps/worker/src/telegram-monitor.ts',
    'apps/worker/src/telegram-state.ts',
]
pattern = re.compile(r'((?:this\.#reporting\.pool|this\.#pool|reporting\.pool|pool)\.query)(?!<)\(')
for name in query_paths:
    path = Path(name)
    text, count = pattern.subn(r'\1<Record<string, unknown>>(', path.read_text())
    if count == 0:
        raise SystemExit(f'expected at least one untyped pg query in {name}')
    path.write_text(text)

# Safe scalar rendering for operational snapshots.
replace(
    'apps/worker/src/telegram-commands.ts',
    "  return `last durable ${String(health.last_durable_cycle_at ?? 'n/a')}, spool ${String(health.spool_pending_count ?? 'n/a')} pending`;",
    "  return `last durable ${displayScalar(health.last_durable_cycle_at)}, spool ${displayScalar(health.spool_pending_count)} pending`;",
)
commands = Path('apps/worker/src/telegram-commands.ts')
text = commands.read_text()
marker = 'function bounded(text: string): string {'
helper = """function displayScalar(value: unknown): string {
  if (value === null || value === undefined) return 'n/a';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value.toString();
  return 'unavailable';
}

"""
if marker not in text:
    raise SystemExit('telegram command bounded marker missing')
commands.write_text(text.replace(marker, helper + marker))

replace(
    'apps/worker/src/telegram-scheduler.ts',
    "  return `last durable ${String(ingestion.last_durable_cycle_at ?? 'n/a')}; spool ${String(ingestion.spool_pending_count ?? 'n/a')} pending; ${openIncidents} ingestion incident(s); ${openMonitors} bot monitor(s)`;",
    "  return `last durable ${displayScalar(ingestion.last_durable_cycle_at)}; spool ${displayScalar(ingestion.spool_pending_count)} pending; ${openIncidents} ingestion incident(s); ${openMonitors} bot monitor(s)`;",
)
scheduler = Path('apps/worker/src/telegram-scheduler.ts')
scheduler.write_text(scheduler.read_text() + """

function displayScalar(value: unknown): string {
  if (value === null || value === undefined) return 'n/a';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value.toString();
  return 'unavailable';
}
""")

# Remove casts made redundant by typed pg rows and render unknown scalar fields safely.
ops = Path('apps/worker/src/reporting-operations.ts')
text = ops.read_text()
for old, new in [
    ("(ingestion.rows[0] as Readonly<Record<string, unknown>> | undefined) ?? null", "ingestion.rows[0] ?? null"),
    ("(canonical.rows[0] as Readonly<Record<string, unknown>> | undefined) ?? null", "canonical.rows[0] ?? null"),
    ("(finalization.rows[0] as Readonly<Record<string, unknown>> | undefined) ?? null", "finalization.rows[0] ?? null"),
    ("(staticFeed.rows[0] as Readonly<Record<string, unknown>> | undefined) ?? null", "staticFeed.rows[0] ?? null"),
    ("monitors.rows as readonly Readonly<Record<string, unknown>>[]", "monitors.rows"),
    ("result.rows as readonly Readonly<Record<string, unknown>>[]", "result.rows"),
    ("row = result.rows[0] as Readonly<Record<string, unknown>> | undefined;", "row = result.rows[0];"),
    ("line: { id: lineId, name: String(lineRow.name_es), code: String(lineRow.public_code) },", "line: { id: lineId, name: displayScalar(lineRow.name_es), code: displayScalar(lineRow.public_code) },"),
    ("? `live:${String(row.state_key)}`", "? `live:${displayScalar(row.state_key)}`"),
    (": `${dateText(row.service_date as string | Date)}:${String(row.journey_id)}`,", ": `${dateText(row.service_date as string | Date)}:${displayScalar(row.journey_id)}`,"),
    ("sourceTripId: String(row.source_trip_id),", "sourceTripId: displayScalar(row.source_trip_id),"),
    ("vehicleId: row.vehicle_id === null ? null : String(row.vehicle_id),", "vehicleId: row.vehicle_id === null ? null : displayScalar(row.vehicle_id),"),
    ("station: row.current_station_name_es === null ? null : String(row.current_station_name_es),", "station: row.current_station_name_es === null ? null : displayScalar(row.current_station_name_es),"),
    ("status: String(row.current_status),", "status: displayScalar(row.current_status),"),
    ("startedServiceDate: row.first_date === null || row.first_date === undefined ? null : String(row.first_date),", "startedServiceDate: row.first_date === null || row.first_date === undefined ? null : displayScalar(row.first_date),"),
    ("latestServiceDate: row.last_date === null || row.last_date === undefined ? null : String(row.last_date),", "latestServiceDate: row.last_date === null || row.last_date === undefined ? null : displayScalar(row.last_date),"),
]:
    if old not in text:
        raise SystemExit(f'missing reporting-operations target: {old[:100]}')
    text = text.replace(old, new)
ops_marker = 'function percent(value: number | null): string {'
ops_helper = """function displayScalar(value: unknown): string {
  if (value === null || value === undefined) return 'n/a';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value.toString();
  return 'unavailable';
}

"""
if ops_marker not in text:
    raise SystemExit('reporting-operations formatter marker missing')
ops.write_text(text.replace(ops_marker, ops_helper + ops_marker))

# Avoid Object.fromEntries inference through unknown pg columns.
replace(
    'apps/worker/src/resources.ts',
    """    const total = Number(row.database_bytes);
    const keys = ['poll_run_bytes', 'stop_evidence_bytes', 'journey_bytes', 'daily_aggregate_bytes'] as const;
    return {
      total: Number.isFinite(total) ? available(total) : unavailable('database size is not numeric'),
      breakdown: Object.fromEntries(keys.map((key) => [key, Number(row[key])]).filter((entry) => Number.isFinite(entry[1]))),
    };""",
    """    const total = Number(row.database_bytes);
    const keys = ['poll_run_bytes', 'stop_evidence_bytes', 'journey_bytes', 'daily_aggregate_bytes'] as const;
    const breakdown: Record<string, number> = {};
    for (const key of keys) {
      const value = Number(row[key]);
      if (Number.isFinite(value)) breakdown[key] = value;
    }
    return {
      total: Number.isFinite(total) ? available(total) : unavailable('database size is not numeric'),
      breakdown,
    };""",
)

# Type the two integration result rows that are inspected directly.
replace(
    'tests/integration/milestone5.test.ts',
    "const result = await telegram.query(\"SELECT failure_class FROM operations.telegram_delivery WHERE delivery_key = 'ci-command'\");",
    "const result = await telegram.query<{ failure_class: string | null }>(\"SELECT failure_class FROM operations.telegram_delivery WHERE delivery_key = 'ci-command'\");",
)
replace(
    'tests/integration/milestone5.test.ts',
    "const ledger = await databaseAdmin.query('SELECT name FROM operations.schema_migration ORDER BY name');",
    "const ledger = await databaseAdmin.query<{ name: string }>('SELECT name FROM operations.schema_migration ORDER BY name');",
)

# Node's test() returns a promise under the project lint rules; explicitly ignore the registration promise.
for name in ['tests/unit/milestone5-telegram.test.ts', 'tests/unit/milestone5-monitor.test.ts']:
    path = Path(name)
    path.write_text(re.sub(r'(?m)^test\(', 'void test(', path.read_text()))

# Keep fake fetch values narrowed rather than stringifying Request/BodyInit objects.
replace(
    'tests/unit/milestone5-telegram.test.ts',
    "    const method = String(input).split('/').at(-1) ?? '';\n    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;",
    "    const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;\n    const method = requestUrl.split('/').at(-1) ?? '';\n    const rawBody = typeof init?.body === 'string' ? init.body : '{}';\n    const body = JSON.parse(rawBody) as Record<string, unknown>;",
)

# Keep the fake Bot API self-contained with explicit Node imports.
fixture = Path('tests/fixtures/fake-telegram-server.mjs')
text = fixture.read_text()
for old, new in [
    ("import { createServer } from 'node:http';", "import { Buffer } from 'node:buffer';\nimport { createServer } from 'node:http';\nimport { setTimeout as sleep } from 'node:timers/promises';"),
    ("  let body = {};\n  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return json(response, 400, { ok: false }); }", "  let body;\n  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return json(response, 400, { ok: false }); }"),
    ("if (result.length === 0) await new Promise((resolve) => setTimeout(resolve, 50));", "if (result.length === 0) await sleep(50);"),
]:
    if old not in text:
        raise SystemExit(f'missing fake Telegram target: {old[:80]}')
    text = text.replace(old, new)
fixture.write_text(text)

# Test doubles may intentionally return promises without an await expression; production code keeps the rule enabled.
eslint = Path('eslint.config.mjs')
text = eslint.read_text()
marker = "  {\n    files: ['**/*.mjs'],"
override = """  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },
"""
if marker not in text:
    raise SystemExit('eslint mjs override marker missing')
eslint.write_text(text.replace(marker, override + marker))
