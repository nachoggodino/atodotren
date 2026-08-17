import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { migrationFilePattern } from './contract.js';

export interface MigrationFile {
  readonly name: string;
  readonly sequence: number;
  readonly sql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly name: string;
  readonly checksum: string;
}

export interface MigrationState {
  readonly pending: readonly MigrationFile[];
  readonly applied: readonly MigrationFile[];
}

export class MigrationInventoryError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MigrationInventoryError';
  }
}

export async function readMigrationInventory(directory: string): Promise<readonly MigrationFile[]> {
  const absoluteDirectory = resolve(directory);
  let entries;
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    throw new MigrationInventoryError(
      `Migration inventory cannot be read from ${absoluteDirectory}`,
      { cause: error },
    );
  }

  const sqlEntries = entries.filter((entry) => entry.name.endsWith('.sql'));
  const invalid = sqlEntries.filter(
    (entry) => !entry.isFile() || !migrationFilePattern.test(entry.name),
  );
  if (invalid.length > 0) {
    throw new MigrationInventoryError(
      `Invalid migration filename(s): ${invalid.map((entry) => entry.name).sort().join(', ')}`,
    );
  }
  if (sqlEntries.length === 0) {
    throw new MigrationInventoryError(`No migration files found in ${absoluteDirectory}`);
  }

  const parsed = sqlEntries.map((entry) => {
    const match = migrationFilePattern.exec(entry.name);
    if (match?.[1] === undefined) {
      throw new MigrationInventoryError(`Invalid migration filename: ${entry.name}`);
    }
    return { name: entry.name, sequence: Number(match[1]) };
  });
  const duplicateSequences = parsed
    .filter(
      (migration, index, migrations) =>
        migrations.findIndex((candidate) => candidate.sequence === migration.sequence) !== index,
    )
    .map((migration) => migration.sequence.toString().padStart(4, '0'));
  if (duplicateSequences.length > 0) {
    throw new MigrationInventoryError(
      `Duplicate migration sequence prefix(es): ${[...new Set(duplicateSequences)].join(', ')}`,
    );
  }

  parsed.sort((left, right) => left.sequence - right.sequence || left.name.localeCompare(right.name));
  return Promise.all(
    parsed.map(async ({ name, sequence }) => {
      const sql = await readFile(resolve(absoluteDirectory, name), 'utf8');
      return {
        name,
        sequence,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    }),
  );
}

export function reconcileMigrationState(
  inventory: readonly MigrationFile[],
  appliedMigrations: readonly AppliedMigration[],
): MigrationState {
  const repository = new Map(inventory.map((migration) => [migration.name, migration]));
  const appliedNames = new Set<string>();

  for (const applied of appliedMigrations) {
    if (appliedNames.has(applied.name)) {
      throw new MigrationInventoryError(`Migration ledger contains duplicate ${applied.name}`);
    }
    appliedNames.add(applied.name);
    const repositoryMigration = repository.get(applied.name);
    if (repositoryMigration === undefined) {
      throw new MigrationInventoryError(
        `Applied migration ${applied.name} is missing from the repository`,
      );
    }
    if (repositoryMigration.checksum !== applied.checksum) {
      throw new MigrationInventoryError(`Applied migration ${applied.name} has been modified`);
    }
  }

  return {
    applied: inventory.filter((migration) => appliedNames.has(migration.name)),
    pending: inventory.filter((migration) => !appliedNames.has(migration.name)),
  };
}
