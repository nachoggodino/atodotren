export const atodotrenRoles = {
  migrationAdmin: 'atodotren_migration_admin',
  ingestWriter: 'atodotren_ingest_writer',
  webReader: 'atodotren_web_reader',
  backupReader: 'atodotren_backup_reader',
  monitorReader: 'atodotren_monitor_reader',
  reportingReader: 'atodotren_reporting_reader',
  migratorLogin: 'atodotren_migrator',
  workerLogin: 'atodotren_worker',
  telegramLogin: 'atodotren_telegram',
} as const;

export const atodotrenGroupRoles = [
  atodotrenRoles.migrationAdmin,
  atodotrenRoles.ingestWriter,
  atodotrenRoles.webReader,
  atodotrenRoles.backupReader,
  atodotrenRoles.monitorReader,
  atodotrenRoles.reportingReader,
] as const;

export const privateSchemas = [
  'gtfs_static',
  'ingest',
  'core',
  'analytics',
  'api',
  'operations',
] as const;

export const runtimeSchemas = privateSchemas.filter((schema) => schema !== 'api');

export const supportedPostgresMajors = { minimum: 16, maximum: 18 } as const;

export const migrationFilePattern = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/u;
