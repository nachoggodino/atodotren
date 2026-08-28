import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  acquireStaticArchive,
  defaultStaticImportLimits,
  formatHumanReport,
  sanitizeReportMessage,
  StaticImportError,
  type StaticImportReport,
} from '@atodotren/gtfs-static';

import { createFixtureZip } from '../helpers/zip.js';

const fixtureDirectory = resolve('tests/fixtures/gtfs-static/representative');

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
  const directory = await mkdtemp(`${tmpdir()}/atodotren-http-`);
  try {
    const url = `http://127.0.0.1:${address.port}/feed.zip`;
    const first = await acquireStaticArchive({
      source: { kind: 'http', url }, temporaryDirectory: directory,
      limits: defaultStaticImportLimits, forceRecheck: false,
    });
    assert.equal(first.kind, 'archive');
    if (first.kind !== 'archive') return;
    assert.equal(first.httpStatus, 200);
    assert.equal(first.archiveBytes, archive.length);
    await rm(first.path);

    const active = {
      id: '1', sourceUrl: url, sha256: first.checksum, etag: '"fixture-v1"',
      lastModified: 'Mon, 17 Aug 2026 04:00:00 GMT', activatedAt: new Date(),
    };
    const second = await acquireStaticArchive({
      source: { kind: 'http', url }, temporaryDirectory: directory,
      limits: defaultStaticImportLimits, active, forceRecheck: false,
    });
    assert.equal(second.kind, 'unchanged');
    assert.equal(conditionalSeen, true);

    const forced = await acquireStaticArchive({
      source: { kind: 'http', url }, temporaryDirectory: directory,
      limits: defaultStaticImportLimits, active, forceRecheck: true,
    });
    assert.equal(forced.kind, 'archive');
    if (forced.kind === 'archive') await rm(forced.path);

    const differentSource = await acquireStaticArchive({
      source: { kind: 'http', url }, temporaryDirectory: directory,
      limits: defaultStaticImportLimits,
      active: { ...active, sourceUrl: `http://127.0.0.1:${address.port}/different.zip` },
      forceRecheck: false,
    });
    assert.equal(differentSource.kind, 'archive');
    if (differentSource.kind === 'archive') await rm(differentSource.path);

    await assert.rejects(
      acquireStaticArchive({
        source: { kind: 'http', url: `${url}?token=not-allowed` },
        temporaryDirectory: directory, limits: defaultStaticImportLimits, forceRecheck: false,
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
