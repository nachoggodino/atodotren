import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { StaticImportError, type ActiveFeedMetadata, type StaticImportLimits } from './types.js';

export type AcquisitionResult =
  | {
      readonly kind: 'unchanged';
      readonly sourceKind: 'http';
      readonly display: string;
      readonly httpStatus: 304;
      readonly durationMs: number;
      readonly etag?: string;
      readonly lastModified?: string;
    }
  | {
      readonly kind: 'archive';
      readonly sourceKind: 'http' | 'file';
      readonly display: string;
      readonly sourceUrl: string;
      readonly path: string;
      readonly temporary: boolean;
      readonly checksum: string;
      readonly archiveBytes: number;
      readonly durationMs: number;
      readonly httpStatus?: 200;
      readonly etag?: string;
      readonly lastModified?: string;
    };

function boundedHeader(response: Response, name: string): string | undefined {
  const value = response.headers.get(name)?.trim();
  return value === undefined || value === '' ? undefined : value.slice(0, 1024);
}

function safeHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new StaticImportError('configuration', 'source.url.invalid', 'Static source URL is invalid', {}, { cause: error });
  }
  if (url.username !== '' || url.password !== '') {
    throw new StaticImportError('configuration', 'source.url.credentials', 'Static source URL must not contain credentials');
  }
  if ([...url.searchParams.keys()].some((key) => /token|key|secret|password|signature|credential/iu.test(key))) {
    throw new StaticImportError('configuration', 'source.url.credentials', 'Static source URL must not contain credential-like query parameters');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new StaticImportError(
      'configuration',
      'source.url.unsafe',
      'Static source URL must use HTTPS; HTTP is allowed only for a local test server',
    );
  }
  return url;
}

async function checksumFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<{ checksum: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    if (signal?.aborted === true) {
      throw new StaticImportError('interrupted', 'import.interrupted', 'Static import was interrupted');
    }
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw new StaticImportError('acquisition', 'archive.download_size.limit', 'Static archive exceeds the configured download size limit', { limit: maxBytes });
    }
    hash.update(buffer);
  }
  return { checksum: hash.digest('hex'), bytes };
}

export async function acquireStaticArchive(options: {
  readonly source: { readonly kind: 'http'; readonly url: string } | { readonly kind: 'file'; readonly path: string };
  readonly temporaryDirectory: string;
  readonly limits: StaticImportLimits;
  readonly active?: ActiveFeedMetadata;
  readonly forceRecheck: boolean;
  readonly signal?: AbortSignal;
}): Promise<AcquisitionResult> {
  const started = performance.now();
  if (options.source.kind === 'file') {
    const path = resolve(options.source.path);
    let details;
    try {
      details = await stat(path);
    } catch (error) {
      throw new StaticImportError('acquisition', 'source.file.unreadable', 'Local static ZIP cannot be read', { file: basename(path) }, { cause: error });
    }
    if (!details.isFile()) {
      throw new StaticImportError('configuration', 'source.file.not_regular', 'Local static source must be a regular file', { file: basename(path) });
    }
    if (details.size > options.limits.maxArchiveBytes) {
      throw new StaticImportError('acquisition', 'archive.download_size.limit', 'Local static ZIP exceeds the configured archive limit', { limit: options.limits.maxArchiveBytes });
    }
    const checked = await checksumFile(path, options.limits.maxArchiveBytes, options.signal);
    return {
      kind: 'archive',
      sourceKind: 'file',
      display: basename(path),
      sourceUrl: `file:${basename(path)}`,
      path,
      temporary: false,
      checksum: checked.checksum,
      archiveBytes: checked.bytes,
      durationMs: Math.round(performance.now() - started),
    };
  }

  let current = safeHttpUrl(options.source.url);
  const timeoutSignal = AbortSignal.timeout(options.limits.requestTimeoutMs);
  const requestSignal = options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);
  for (let redirects = 0; ; redirects += 1) {
    let response: Response;
    try {
      const headers = new Headers({ accept: 'application/zip, application/octet-stream;q=0.9' });
      let sameSource = false;
      if (options.active !== undefined) {
        try {
          sameSource = new URL(options.active.sourceUrl).href === current.href;
        } catch {
          sameSource = false;
        }
      }
      if (sameSource && !options.forceRecheck && options.active?.etag !== null && options.active?.etag !== undefined) {
        headers.set('if-none-match', options.active.etag);
      }
      if (sameSource && !options.forceRecheck && options.active?.lastModified !== null && options.active?.lastModified !== undefined) {
        headers.set('if-modified-since', options.active.lastModified);
      }
      response = await fetch(current, { method: 'GET', headers, redirect: 'manual', signal: requestSignal });
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw new StaticImportError('interrupted', 'import.interrupted', 'Static import was interrupted', {}, { cause: error });
      }
      if (timeoutSignal.aborted) {
        throw new StaticImportError('timeout', 'source.timeout', `Static source request exceeded ${options.limits.requestTimeoutMs}ms`, { timeoutMs: options.limits.requestTimeoutMs }, { cause: error });
      }
      throw new StaticImportError('acquisition', 'source.network', 'Static source request failed', { host: current.hostname }, { cause: error });
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects >= options.limits.maxRedirects) {
        throw new StaticImportError('http', 'source.redirect.limit', 'Static source exceeded the redirect limit', { limit: options.limits.maxRedirects });
      }
      const location = response.headers.get('location');
      if (location === null) {
        throw new StaticImportError('http', 'source.redirect.missing', 'Static source redirect omitted Location');
      }
      current = safeHttpUrl(new URL(location, current).toString());
      continue;
    }

    const etag = boundedHeader(response, 'etag');
    const lastModified = boundedHeader(response, 'last-modified');
    if (response.status === 304) {
      return {
        kind: 'unchanged',
        sourceKind: 'http',
        display: current.hostname,
        httpStatus: 304,
        durationMs: Math.round(performance.now() - started),
        ...(etag === undefined ? {} : { etag }),
        ...(lastModified === undefined ? {} : { lastModified }),
      };
    }
    if (response.status !== 200 || response.body === null) {
      throw new StaticImportError('http', 'source.http_status', `Static source returned HTTP ${response.status}`, { status: response.status, host: current.hostname });
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) > options.limits.maxArchiveBytes) {
      throw new StaticImportError('acquisition', 'archive.download_size.limit', 'Static source Content-Length exceeds the configured archive limit', { limit: options.limits.maxArchiveBytes });
    }

    const target = join(options.temporaryDirectory, 'download.zip');
    const handle = await open(target, 'wx', 0o600);
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        if (requestSignal.aborted) {
          throw new StaticImportError(
            options.signal?.aborted === true ? 'interrupted' : 'timeout',
            options.signal?.aborted === true ? 'import.interrupted' : 'source.timeout',
            options.signal?.aborted === true ? 'Static import was interrupted' : 'Static source download timed out',
          );
        }
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > options.limits.maxArchiveBytes) {
          throw new StaticImportError('acquisition', 'archive.download_size.limit', 'Static archive exceeds the configured download size limit', { limit: options.limits.maxArchiveBytes });
        }
        hash.update(buffer);
        await handle.write(buffer);
      }
    } finally {
      await handle.close();
    }
    return {
      kind: 'archive',
      sourceKind: 'http',
      display: current.hostname,
      sourceUrl: current.toString(),
      path: target,
      temporary: true,
      checksum: hash.digest('hex'),
      archiveBytes: bytes,
      durationMs: Math.round(performance.now() - started),
      httpStatus: 200,
      ...(etag === undefined ? {} : { etag }),
      ...(lastModified === undefined ? {} : { lastModified }),
    };
  }
}
