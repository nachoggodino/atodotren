import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireStaticArchive, type AcquisitionResult } from './acquisition.js';
import { inspectAndExtractGtfs } from './archive.js';
import { loadAndActivateFeed, readActiveFeed, recordRejectedVersion } from './database.js';
import { normalizeMadridGtfs } from './normalize.js';
import { sanitizeReportMessage } from './report.js';
import {
  defaultStaticImportLimits,
  renfeMadridMapping,
  StaticImportError,
  type ImportStaticOptions,
  type StaticImportReport,
} from './types.js';

function failure(error: unknown): StaticImportError {
  if (error instanceof StaticImportError) return error;
  return new StaticImportError('database', 'import.unexpected', 'Unexpected static import failure', {}, { cause: error });
}

function sourceDisplay(source: ImportStaticOptions['source']): { kind: 'http' | 'file'; display: string } {
  if (source.kind === 'file') {
    const pieces = source.path.replaceAll('\\', '/').split('/');
    return { kind: 'file', display: pieces.at(-1)?.slice(0, 128) ?? 'local.zip' };
  }
  try {
    return { kind: 'http', display: new URL(source.url).hostname.slice(0, 128) };
  } catch {
    return { kind: 'http', display: 'invalid-source' };
  }
}

export async function importStaticFeed(options: ImportStaticOptions): Promise<StaticImportReport> {
  const started = performance.now();
  const limits = { ...defaultStaticImportLimits, ...options.limits };
  const mapping = options.mapping ?? renfeMadridMapping;
  const timings: Record<string, number> = {};
  const tempBase = options.temporaryDirectory ?? tmpdir();
  let temporaryDirectory: string | undefined;
  let acquired: AcquisitionResult | undefined;
  let parsedReport: Pick<StaticImportReport, 'parsed' | 'retained' | 'discarded' | 'dimensions' | 'mappingCoverage' | 'warnings'> | undefined;
  try {
    try {
      temporaryDirectory = await mkdtemp(join(tempBase, 'atodotren-static-'));
    } catch (error) {
      throw new StaticImportError(
        'configuration',
        'temporary_directory.unavailable',
        'Static import temporary directory is unavailable',
        {},
        { cause: error },
      );
    }
    const active = await readActiveFeed(options.pool, mapping.networkSlug);
    const acquisitionStarted = performance.now();
    try {
      acquired = await acquireStaticArchive({
        source: options.source,
        temporaryDirectory,
        limits,
        ...(active === undefined ? {} : { active }),
        forceRecheck: options.forceRecheck ?? false,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } finally {
      timings.acquisition = Math.round(performance.now() - acquisitionStarted);
    }
    if (acquired.kind === 'unchanged') {
      if (active === undefined) {
        throw new StaticImportError(
          'http',
          'source.not_modified_without_active',
          'Static source returned 304 but no active Madrid version exists',
        );
      }
      return {
        ok: true,
        result: 'unchanged',
        source: { kind: acquired.sourceKind, display: acquired.display },
        fetch: {
          status: 'not-modified',
          httpStatus: 304,
          durationMs: acquired.durationMs,
          ...(acquired.etag === undefined ? {} : { etag: acquired.etag }),
          ...(acquired.lastModified === undefined ? {} : { lastModified: acquired.lastModified }),
        },
        checksum: active.sha256,
        feedVersionId: active.id,
        feedVersionStatus: 'active',
        currentVersionId: active.id,
        warnings: [],
        rejectionCount: 0,
        activation: 'unchanged',
        timingsMs: timings,
        totalDurationMs: Math.round(performance.now() - started),
      };
    }
    if (active?.sha256 === acquired.checksum) {
      return {
        ok: true,
        result: 'unchanged',
        source: { kind: acquired.sourceKind, display: acquired.display },
        fetch: {
          status: 'checksum-match',
          ...(acquired.httpStatus === undefined ? {} : { httpStatus: acquired.httpStatus }),
          ...(acquired.etag === undefined ? {} : { etag: acquired.etag }),
          ...(acquired.lastModified === undefined ? {} : { lastModified: acquired.lastModified }),
          archiveBytes: acquired.archiveBytes,
          durationMs: acquired.durationMs,
        },
        checksum: acquired.checksum,
        feedVersionId: active.id,
        feedVersionStatus: 'active',
        warnings: [],
        rejectionCount: 0,
        activation: 'unchanged',
        currentVersionId: active.id,
        timingsMs: timings,
        totalDurationMs: Math.round(performance.now() - started),
      };
    }

    const inspectionStarted = performance.now();
    const extracted = await inspectAndExtractGtfs(
      acquired.path,
      join(temporaryDirectory, 'entries'),
      limits,
      options.signal,
    );
    timings.archiveInspection = Math.round(performance.now() - inspectionStarted);
    void extracted.entryCount;
    void extracted.totalUncompressedBytes;

    const parsingStarted = performance.now();
    const feed = await normalizeMadridGtfs(extracted.files, mapping, limits);
    timings.parseAndValidate = Math.round(performance.now() - parsingStarted);
    parsedReport = {
      parsed: feed.parsed,
      retained: feed.retained,
      discarded: feed.discarded,
      dimensions: {
        stations: feed.stations.length,
        lines: feed.lines.length,
        branches: feed.branches.length,
        servicePatterns: feed.patterns.length,
        segments: feed.patterns.reduce((sum, pattern) => sum + pattern.stationPublicIds.length - 1, 0),
      },
      mappingCoverage: { routes: feed.routes.length, trips: feed.tripMappings.length, stops: feed.stops.length },
      warnings: feed.warnings.slice(0, 20),
    };
    const databaseStarted = performance.now();
    const loaded = await loadAndActivateFeed({
      pool: options.pool,
      sourceUrl: acquired.sourceUrl,
      checksum: acquired.checksum,
      archiveBytes: acquired.archiveBytes,
      ...(acquired.etag === undefined ? {} : { etag: acquired.etag }),
      ...(acquired.lastModified === undefined ? {} : { lastModified: acquired.lastModified }),
      feed,
      report: {
        checksum: acquired.checksum,
        parsed: feed.parsed,
        retained: feed.retained,
        discarded: feed.discarded,
        warnings: feed.warnings.slice(0, 20),
      },
    });
    timings.database = Math.round(performance.now() - databaseStarted);
    const unchanged = loaded.kind === 'unchanged';
    return {
      ok: true,
      result: unchanged ? 'unchanged' : 'imported',
      source: { kind: acquired.sourceKind, display: acquired.display },
      fetch: {
        status: acquired.sourceKind === 'file' ? 'local' : 'downloaded',
        ...(acquired.httpStatus === undefined ? {} : { httpStatus: acquired.httpStatus }),
        ...(acquired.etag === undefined ? {} : { etag: acquired.etag }),
        ...(acquired.lastModified === undefined ? {} : { lastModified: acquired.lastModified }),
        archiveBytes: acquired.archiveBytes,
        durationMs: acquired.durationMs,
      },
      checksum: acquired.checksum,
      feedVersionId: loaded.feedVersionId,
      feedVersionStatus: unchanged ? 'active-or-superseded' : 'active',
      ...parsedReport,
      rejectionCount: 0,
      activation: unchanged ? 'unchanged' : 'activated',
      ...(loaded.previousVersionId === undefined ? {} : { previousVersionId: loaded.previousVersionId }),
      currentVersionId: unchanged ? active?.id ?? loaded.feedVersionId : loaded.feedVersionId,
      timingsMs: timings,
      totalDurationMs: Math.round(performance.now() - started),
    };
  } catch (unknownError) {
    const error = failure(unknownError);
    const safeMessage = sanitizeReportMessage(error.message);
    let rejectedVersionId: string | undefined;
    if (acquired?.kind === 'archive') {
      rejectedVersionId = await recordRejectedVersion({
        pool: options.pool,
        sourceUrl: acquired.sourceUrl,
        checksum: acquired.checksum,
        archiveBytes: acquired.archiveBytes,
        ...(acquired.etag === undefined ? {} : { etag: acquired.etag }),
        ...(acquired.lastModified === undefined ? {} : { lastModified: acquired.lastModified }),
        code: error.code,
        message: safeMessage,
        report: { ok: false, code: error.code, kind: error.kind },
      });
    }
    return {
      ok: false,
      result: 'rejected',
      source: acquired?.kind === 'archive'
        ? { kind: acquired.sourceKind, display: acquired.display }
        : sourceDisplay(options.source),
      fetch: acquired?.kind === 'archive'
        ? {
            status: acquired.sourceKind === 'file' ? 'local' : 'downloaded',
            ...(acquired.httpStatus === undefined ? {} : { httpStatus: acquired.httpStatus }),
            ...(acquired.etag === undefined ? {} : { etag: acquired.etag }),
            ...(acquired.lastModified === undefined ? {} : { lastModified: acquired.lastModified }),
            archiveBytes: acquired.archiveBytes,
            durationMs: acquired.durationMs,
          }
        : { status: 'failed', durationMs: timings.acquisition ?? 0 },
      ...(acquired?.kind === 'archive' ? { checksum: acquired.checksum } : {}),
      ...(rejectedVersionId === undefined ? {} : { feedVersionId: rejectedVersionId, feedVersionStatus: 'rejected' }),
      ...(parsedReport ?? { warnings: [] }),
      rejectionCount: 1,
      activation: 'not-attempted',
      timingsMs: timings,
      totalDurationMs: Math.round(performance.now() - started),
      error: { kind: error.kind, code: error.code, message: safeMessage },
    };
  } finally {
    if (temporaryDirectory !== undefined) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}
