import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import yauzl, { type Entry, type ZipFile } from 'yauzl';

import { StaticImportError, type StaticImportLimits } from './types.js';

const recognizedEntries = new Set([
  'agency.txt',
  'stops.txt',
  'routes.txt',
  'trips.txt',
  'stop_times.txt',
  'calendar.txt',
  'calendar_dates.txt',
  'shapes.txt',
  'feed_info.txt',
]);
const requiredEntries = ['agency.txt', 'stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt'] as const;

export interface ExtractedGtfsArchive {
  readonly files: ReadonlyMap<string, string>;
  readonly entryCount: number;
  readonly totalUncompressedBytes: number;
}

function archiveError(code: string, message: string, details: Readonly<Record<string, unknown>> = {}, cause?: unknown): StaticImportError {
  return new StaticImportError('archive', code, message, details, cause === undefined ? undefined : { cause });
}

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (error, zip) => {
      if (error !== null) reject(archiveError('archive.open.failed', 'Unable to open GTFS ZIP archive', {}, error));
      else if (zip === undefined) reject(archiveError('archive.open.failed', 'ZIP reader returned no archive'));
      else resolve(zip);
    });
  });
}

function openEntry(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error !== null) reject(archiveError('archive.entry.open_failed', `Unable to read ${entry.fileName}`, { entry: entry.fileName }, error));
      else if (stream === undefined) reject(archiveError('archive.entry.open_failed', `ZIP reader returned no stream for ${entry.fileName}`));
      else resolve(stream);
    });
  });
}

export async function inspectAndExtractGtfs(
  zipPath: string,
  targetDirectory: string,
  limits: StaticImportLimits,
  signal?: AbortSignal,
): Promise<ExtractedGtfsArchive> {
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  const zip = await openZip(zipPath);
  const files = new Map<string, string>();
  const seen = new Set<string>();
  let entryCount = 0;
  let totalDeclaredBytes = 0;
  let totalActualBytes = 0;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finishReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      zip.close();
      if (error instanceof StaticImportError) {
        reject(error);
      } else if (error instanceof Error && /invalid relative path|absolute path|backslash/iu.test(error.message)) {
        reject(archiveError('archive.path.unsafe', 'Archive contains an unsafe filename', {}, error));
      } else {
        reject(archiveError('archive.read.failed', 'GTFS ZIP inspection failed', {}, error));
      }
    };
    const abort = (): void => finishReject(new StaticImportError('interrupted', 'import.interrupted', 'Static import was interrupted'));
    signal?.addEventListener('abort', abort, { once: true });
    zip.once('error', finishReject);
    zip.once('end', () => {
      if (settled) return;
      for (const required of requiredEntries) {
        if (!files.has(required)) {
          finishReject(archiveError('archive.entry.missing', `Required GTFS entry ${required} is missing`, { entry: required }));
          return;
        }
      }
      if (!files.has('calendar.txt') && !files.has('calendar_dates.txt')) {
        finishReject(archiveError('archive.calendar.missing', 'GTFS archive must contain calendar.txt or calendar_dates.txt'));
        return;
      }
      settled = true;
      signal?.removeEventListener('abort', abort);
      resolve({ files, entryCount, totalUncompressedBytes: totalActualBytes });
    });
    zip.on('entry', (entry: Entry) => {
      void (async () => {
        if (signal?.aborted === true) throw new StaticImportError('interrupted', 'import.interrupted', 'Static import was interrupted');
        entryCount += 1;
        if (entryCount > limits.maxEntries) {
          throw archiveError('archive.entries.limit', `Archive contains more than ${limits.maxEntries} entries`, { limit: limits.maxEntries });
        }
        const filename = entry.fileName;
        if (!/^[A-Za-z0-9_.-]+$/u.test(filename) || filename.includes('..')) {
          throw archiveError('archive.path.unsafe', 'Archive contains an unsafe filename', { entry: filename.slice(0, 128) });
        }
        const normalized = filename.toLowerCase();
        if (seen.has(normalized)) {
          throw archiveError('archive.entry.duplicate', `Archive contains duplicate entry ${normalized}`, { entry: normalized });
        }
        seen.add(normalized);
        if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
          throw archiveError('archive.entry.encrypted', `Encrypted ZIP entry ${normalized} is not supported`, { entry: normalized });
        }
        totalDeclaredBytes += entry.uncompressedSize;
        if (totalDeclaredBytes > limits.maxTotalUncompressedBytes) {
          throw archiveError('archive.total_size.limit', 'Archive declared uncompressed size exceeds the configured limit', {
            limit: limits.maxTotalUncompressedBytes,
          });
        }
        if (!recognizedEntries.has(normalized)) {
          zip.readEntry();
          return;
        }
        const entryLimit = normalized === 'stop_times.txt' ? limits.maxStopTimesEntryBytes : limits.maxEntryBytes;
        if (entry.uncompressedSize > entryLimit) {
          throw archiveError('archive.entry_size.limit', `${normalized} exceeds its uncompressed size limit`, {
            entry: normalized,
            limit: entryLimit,
          });
        }
        const target = join(targetDirectory, normalized);
        const input = await openEntry(zip, entry);
        let actualBytes = 0;
        const counter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            actualBytes += chunk.length;
            totalActualBytes += chunk.length;
            if (actualBytes > entryLimit || totalActualBytes > limits.maxTotalUncompressedBytes) {
              callback(archiveError('archive.decompressed_size.limit', 'Archive exceeded a decompressed size limit', { entry: normalized }));
              return;
            }
            callback(null, chunk);
          },
        });
        await pipeline(input, counter, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
        files.set(normalized, target);
        zip.readEntry();
      })().catch(finishReject);
    });
    zip.readEntry();
  });
}
