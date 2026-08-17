import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  acquireStaticArchive,
  defaultStaticImportLimits,
  formatHumanReport,
  hashServicePattern,
  inspectAndExtractGtfs,
  normalizeMadridGtfs,
  parseGtfsTime,
  readCsvRecords,
  renfeMadridMapping,
  sanitizeReportMessage,
  StaticImportError,
  type StaticImportReport,
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
      for await (const row of readCsvRecords(duplicate, { file: 'duplicate.txt', required: ['id'] }, 1024)) {
        // Consume the stream to trigger header validation.
        void row;
      }
    }, (error) => error instanceof StaticImportError && error.code === 'csv.header.malformed');

    const oversized = join(directory, 'oversized.txt');
    await writeFile(oversized, `id,name\n1,${'x'.repeat(100)}\n`);
    await assert.rejects(async () => {
      for await (const row of readCsvRecords(oversized, { file: 'oversized.txt', required: ['id', 'name'] }, 32)) {
        // Consume the stream to trigger the row bound.
        void row;
      }
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

void test('representative fixture retains only explicitly mapped Madrid facts and builds deterministic topology', async () => {
  const files = new Map(
    ['agency.txt', 'routes.txt', 'trips.txt', 'stops.txt', 'stop_times.txt', 'calendar.txt', 'shapes.txt'].map((name) => [
      name,
      join(fixtureDirectory, name),
    ]),
  );
  const feed = await normalizeMadridGtfs(files, {
    ...renfeMadridMapping,
    canaries: {
      requiredLineCodes: ['C-1'],
      requiredStationPublicIds: ['atocha', 'aeropuerto-t4'],
      minimumStations: 3,
      minimumTrips: 1,
      requireReferencedShapes: true,
    },
  }, defaultStaticImportLimits);
  assert.deepEqual(feed.retained, {
    routes: 1,
    trips: 1,
    stops: 3,
    stopTimes: 4,
    calendarServices: 1,
    calendarExceptions: 0,
    shapes: 1,
    shapePoints: 3,
  });
  assert.equal(feed.discarded.routes, 1);
  assert.equal(feed.discarded.trips, 3);
  assert.equal(feed.discarded.stopTimes, 3);
  assert.equal(feed.trips[0]?.directionId, null);
  assert.deepEqual(feed.stopTimes.map((item) => item.arrivalSeconds), [86_399, 87_300, 90_000, 90_960]);
  assert.equal(feed.patterns.length, 1);
  assert.equal(feed.patterns[0]?.hash, hashServicePattern(['atocha', 'nuevos-ministerios', 'aeropuerto-t4']));
  assert.deepEqual(feed.patterns[0]?.stationPublicIds, ['atocha', 'nuevos-ministerios', 'aeropuerto-t4']);
  assert.equal(feed.branches.length, 1);
  assert.equal(feed.patterns[0]?.stationPublicIds.length, 3);
  assert.ok(feed.warnings.some((warning) => /Discarded 2 Madrid trip records/u.test(warning)));
  assert.ok(feed.warnings.some((warning) => /direction_id absent/u.test(warning)));
  assert.ok(feed.warnings.some((warning) => /Collapsed 1 consecutive duplicate canonical-station call/u.test(warning)));
});

void test('Madrid mapping rejects ambiguous route and station candidates', async () => {
  const files = new Map(
    ['agency.txt', 'routes.txt', 'trips.txt', 'stops.txt', 'stop_times.txt', 'calendar.txt', 'shapes.txt'].map((name) => [name, join(fixtureDirectory, name)]),
  );
  await assert.rejects(
    normalizeMadridGtfs(files, {
      ...renfeMadridMapping,
      routeRules: [...renfeMadridMapping.routeRules, { ...renfeMadridMapping.routeRules[0]!, id: 'duplicate-rule' }],
    }, defaultStaticImportLimits),
    (error) => error instanceof StaticImportError && error.code === 'mapping.route.ambiguous',
  );
});

void test('conditional HTTP acquisition handles 200 and 304 without internet', async () => {
  const archive = await createFixtureZip(fixtureDirectory);
  let conditionalSeen = false;
  const server = createServer((request, response) => {
    if (request.headers['if-none-match'] === '"fixture-v1"') {
      conditionalSeen = true;
      response.writeHead(304, { etag: '"fixture-v1"' });
      response.end();
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': String(archive.length),
      etag: '"fixture-v1"',
      'last-modified': 'Mon, 17 Aug 2026 04:00:00 GMT',
    });
    response.end(archive);
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const directory = await mkdtemp(join(tmpdir(), 'atodotren-http-'));
  try {
    const url = `http://127.0.0.1:${address.port}/feed.zip`;
    const first = await acquireStaticArchive({
      source: { kind: 'http', url },
      temporaryDirectory: directory,
      limits: defaultStaticImportLimits,
      forceRecheck: false,
    });
    assert.equal(first.kind, 'archive');
    if (first.kind !== 'archive') return;
    assert.equal(first.httpStatus, 200);
    assert.equal(first.archiveBytes, archive.length);
    await rm(first.path);
    const second = await acquireStaticArchive({
      source: { kind: 'http', url },
      temporaryDirectory: directory,
      limits: defaultStaticImportLimits,
      active: {
        id: '1',
        sourceUrl: url,
        sha256: first.checksum,
        etag: '"fixture-v1"',
        lastModified: 'Mon, 17 Aug 2026 04:00:00 GMT',
        activatedAt: new Date(),
      },
      forceRecheck: false,
    });
    assert.equal(second.kind, 'unchanged');
    assert.equal(conditionalSeen, true);
    const forced = await acquireStaticArchive({
      source: { kind: 'http', url },
      temporaryDirectory: directory,
      limits: defaultStaticImportLimits,
      active: {
        id: '1',
        sourceUrl: url,
        sha256: first.checksum,
        etag: '"fixture-v1"',
        lastModified: 'Mon, 17 Aug 2026 04:00:00 GMT',
        activatedAt: new Date(),
      },
      forceRecheck: true,
    });
    assert.equal(forced.kind, 'archive');
    if (forced.kind === 'archive') await rm(forced.path);
    const differentSource = await acquireStaticArchive({
      source: { kind: 'http', url },
      temporaryDirectory: directory,
      limits: defaultStaticImportLimits,
      active: {
        id: '1',
        sourceUrl: `http://127.0.0.1:${address.port}/different.zip`,
        sha256: first.checksum,
        etag: '"fixture-v1"',
        lastModified: 'Mon, 17 Aug 2026 04:00:00 GMT',
        activatedAt: new Date(),
      },
      forceRecheck: false,
    });
    assert.equal(differentSource.kind, 'archive');
    if (differentSource.kind === 'archive') await rm(differentSource.path);
    await assert.rejects(
      acquireStaticArchive({
        source: { kind: 'http', url: `${url}?token=not-allowed` },
        temporaryDirectory: directory,
        limits: defaultStaticImportLimits,
        forceRecheck: false,
      }),
      (error) => error instanceof StaticImportError && error.code === 'source.url.credentials',
    );
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error === undefined ? resolveClose() : rejectClose(error)));
    await rm(directory, { recursive: true, force: true });
  }
});

void test('reports redact secrets, bound messages, and remain concise', () => {
  const unsafe = `postgresql://worker:secret@example/db?token=abc\n${'x'.repeat(1000)}`;
  const safe = sanitizeReportMessage(unsafe);
  assert.doesNotMatch(safe, /secret|token=abc/u);
  assert.ok(safe.length <= 512);
  const report: StaticImportReport = {
    ok: false,
    result: 'rejected',
    source: { kind: 'file', display: 'fixture.zip' },
    fetch: { status: 'local', durationMs: 1 },
    warnings: [],
    rejectionCount: 1,
    activation: 'not-attempted',
    timingsMs: {},
    totalDurationMs: 2,
    error: { kind: 'validation', code: 'test.rejected', message: unsafe },
  };
  const human = formatHumanReport(report);
  assert.doesNotMatch(human, /secret|token=abc/u);
  assert.match(human, /test\.rejected/u);
});
