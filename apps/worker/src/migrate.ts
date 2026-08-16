#!/usr/bin/env node
import { resolve } from 'node:path';

import { ConfigError, loadConfig } from '@atodotren/config';
import { migrateToLatest } from '@atodotren/db';
import { createLogger } from '@atodotren/observability';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ service: 'atodotren-migrations', level: config.logLevel });
  const result = await migrateToLatest({
    connection: config.migrationDatabase,
    migrationsDirectory: process.env.MIGRATIONS_DIR ?? resolve(process.cwd(), 'migrations'),
    logger,
  });
  logger.info('migration.run.completed', 'Database migration run completed', {
    applied: result.applied,
    alreadyApplied: result.alreadyApplied,
  });
}

main().catch((error: unknown) => {
  const logger = createLogger({ service: 'atodotren-migrations', level: 'error' });
  if (error instanceof ConfigError) {
    logger.error('config.invalid', 'Environment configuration is invalid', {
      issues: error.issues,
    });
  } else {
    logger.error('migration.run.failed', 'Database migration run failed', { error });
  }
  process.exitCode = 1;
});
