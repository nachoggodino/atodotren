import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MigrationInventoryError,
  readMigrationInventory,
  reconcileMigrationState,
} from '@atodotren/db';

async function temporaryInventory(files: Readonly<Record<string, string>>, action: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'atodotren-inventory-'));
  try {
    await Promise.all(Object.entries(files).map(([name, contents]) => writeFile(join(directory, name), contents)));
    await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void test('inventory accepts gaps, sorts by sequence, and calculates SHA-256 checksums', async () => {
  await temporaryInventory({ '0003_third.sql': 'SELECT 3;\n', '0001_first.sql': 'SELECT 1;\n' }, async (directory) => {
    const inventory = await readMigrationInventory(directory);
    assert.deepEqual(inventory.map((migration) => migration.name), ['0001_first.sql', '0003_third.sql']);
    assert.match(inventory[0]?.checksum ?? '', /^[0-9a-f]{64}$/u);
  });
});

void test('inventory rejects malformed SQL names, duplicate prefixes, and emptiness', async () => {
  await temporaryInventory({ '1_bad.sql': '' }, async (directory) => {
    await assert.rejects(readMigrationInventory(directory), /Invalid migration filename/u);
  });
  await temporaryInventory({ '0001_first.sql': '', '0001_other.sql': '' }, async (directory) => {
    await assert.rejects(readMigrationInventory(directory), /Duplicate migration sequence/u);
  });
  await temporaryInventory({ 'README.md': 'none' }, async (directory) => {
    await assert.rejects(readMigrationInventory(directory), /No migration files/u);
  });
  await assert.rejects(readMigrationInventory('/definitely/not/an/inventory'), MigrationInventoryError);
});

void test('migration state distinguishes current, stale, fabricated or missing, and checksum mismatch', async () => {
  await temporaryInventory({ '0001_first.sql': 'SELECT 1;\n', '0003_third.sql': 'SELECT 3;\n' }, async (directory) => {
    const inventory = await readMigrationInventory(directory);
    const first = inventory[0];
    const third = inventory[1];
    assert.ok(first !== undefined && third !== undefined);
    assert.equal(reconcileMigrationState(inventory, inventory).pending.length, 0);
    assert.deepEqual(reconcileMigrationState(inventory, [first]).pending.map((migration) => migration.name), ['0003_third.sql']);
    assert.throws(
      () => reconcileMigrationState(inventory, [{ name: '9999_fabricated.sql', checksum: '0'.repeat(64) }]),
      /missing from the repository/u,
    );
    assert.throws(
      () => reconcileMigrationState([third], [first]),
      /missing from the repository/u,
    );
    assert.throws(
      () => reconcileMigrationState(inventory, [{ name: first.name, checksum: '0'.repeat(64) }]),
      /has been modified/u,
    );
  });
});
