import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  defaultStaticImportLimits,
  inspectAndExtractGtfs,
  parseGtfsTime,
  readCsvRecords,
  StaticImportError,
} from '@atodotren/gtfs-static';

import { createFixtureZip, createStoredZip } from '../helpers/zip.js';

const fixtureDirectory = resolve('tests/fixtures/gtfs-static/representative');

void test('GTFS service times support midnight rollover and reject malformed values', () => {
  assert.equal(parseGtfsTime('23:59:59'), 86_399);
  assert.equal(parseGtfsTime('24:00:00'), 86_400);
  assert.equal(parseGtfsTime('25:17:03'), 91_023);
  assert.equal(parseGtfsTime(''), null);
  for (const invalid of ['24:60:00', '-1:00:00', '100:00:00', '12:00', 'abc']) {
    assert.throws(() => parseGtfsTime(invalid), (error) => error instanceof StaticImportError && error.code === 'gtfs.time.invalid');
  }
});

void test('streaming CSV parser handles BOM, quotes, optional blanks, embedded newlines, and CRLF', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atodotren-csv-'));
  try {
    const path = join(directory, 'sample.txt');
    await writeFile(path, '\uFEFFid,name,optional   \r\n1,"A, B",\r\n2,"two ""quotes""\nand a line",x\r\n');
    const rows = [];
    for await (const row of readCsvRecords(path, { file: 'sample.txt', required: ['id', 'name'], optional: ['optional'] }, 1024)) rows.push(row);
    assert.deepEqual(rows, [
      { id: '1', name: 'A, B', optional: '' },
      { id: '2', name: 'two "quotes"\nand a line', optional: 'x' },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('streaming CSV parser rejects malformed headers and oversized rows', async () => {
  const directory = await mkdtemp('/tmp/atodotren-csv-invalid-');
  try {
    const duplicate = join(directory, 'duplicate.txt');
    await writeFile(duplicate, 'id,id\n1,2\n');
    await assert.rejects(async () => {
      for await (const row of readCsvRecords(duplicate, { file: 'duplicate.txt', required: ['id'] }, 1024)) void row;
    }, (error) => error instanceof StaticImportError && error.code === 'csv.header.malformed');

    const oversized = join(directory, 'oversized.txt');
    await writeFile(oversized, `id,name\n1,${'x'.repeat(100)}\n`);
    await assert.rejects(async () => {
      for await (const row of readCsvRecords(oversized, { file: 'oversized.txt', required: ['id', 'name'] }, 32)) void row;
    }, (error) => error instanceof StaticImportError && error.code === 'csv.row.too_large');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('archive inspection enforces safe names, duplicates, required entries, and size limits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atodotren-archive-'));
  try {
    const valid = join(directory, 'valid.zip');
    await writeFile(valid, await createFixtureZip(fixtureDirectory));
    const extracted = await inspectAndExtractGtfs(valid, join(directory, 'valid'), defaultStaticImportLimits);
    assert.ok(extracted.files.has('stop_times.txt'));

    const unsafe = join(directory, 'unsafe.zip');
    await writeFile(unsafe, createStoredZip([{ name: '../routes.txt', data: 'x' }]));
    await assert.rejects(inspectAndExtractGtfs(unsafe, join(directory, 'unsafe'), defaultStaticImportLimits), /invalid relative path|unsafe/iu);

    const duplicate = join(directory, 'duplicate.zip');
    await writeFile(duplicate, createStoredZip([
      { name: 'routes.txt', data: 'route_id,route_short_name,route_long_name,route_type\n' },
      { name: 'ROUTES.TXT', data: 'route_id,route_short_name,route_long_name,route_type\n' },
    ]));
    await assert.rejects(inspectAndExtractGtfs(duplicate, join(directory, 'duplicate'), defaultStaticImportLimits), /duplicate/iu);

    await assert.rejects(
      inspectAndExtractGtfs(valid, join(directory, 'limited'), { ...defaultStaticImportLimits, maxTotalUncompressedBytes: 32 }),
      /size limit|exceeds/iu,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
