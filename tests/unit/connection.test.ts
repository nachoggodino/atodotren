import assert from 'node:assert/strict';
import test from 'node:test';

import { createDatabaseConnection } from '@atodotren/db';

void test('closes an externally created pg pool even before Kysely initializes', async () => {
  const connection = await createDatabaseConnection({
    url: 'postgresql://unused:unused@127.0.0.1:1/unused',
    sslMode: 'disable',
    poolMax: 1,
    connectionTimeoutMs: 100,
    idleTimeoutMs: 30_000,
    statementTimeoutMs: 1_000,
    applicationName: 'atodotren-unit-pool-close',
  });

  assert.equal(connection.pool.ending, false);
  await connection.close();
  assert.equal(connection.pool.ending, true);
  assert.equal(connection.pool.ended, true);
  await connection.close();
});
