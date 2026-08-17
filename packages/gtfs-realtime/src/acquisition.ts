import type { FeedKind } from './types.js';

export interface FeedEndpoint {
  readonly kind: FeedKind;
  readonly url: string;
  readonly enabled: boolean;
}

export interface AcquiredFeed {
  readonly body: Uint8Array;
  readonly status: number;
  readonly responseBytes: number;
  readonly durationMs: number;
  readonly attempts: number;
}

export class FeedAcquisitionError extends Error {
  public readonly code: 'http_4xx' | 'http_5xx' | 'network_error' | 'timeout' | 'response_too_large';
  public readonly status: number | undefined;
  public readonly attempts: number;
  public readonly durationMs: number;

  public constructor(options: {
    code: FeedAcquisitionError['code'];
    message: string;
    status?: number;
    attempts: number;
    durationMs: number;
  }) {
    super(options.message);
    this.name = 'FeedAcquisitionError';
    this.code = options.code;
    this.status = options.status;
    this.attempts = options.attempts;
    this.durationMs = options.durationMs;
  }
}

export interface AcquireOptions {
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly signal?: AbortSignal;
  readonly fetchImplementation?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
}

async function boundedBody(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) {
    throw new FeedAcquisitionError({
      code: 'response_too_large', message: 'Declared feed response exceeds configured limit',
      status: response.status, attempts: 1, durationMs: 0,
    });
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value as Uint8Array;
      total += chunk.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new FeedAcquisitionError({
          code: 'response_too_large', message: 'Feed response exceeds configured limit',
          status: response.status, attempts: 1, durationMs: 0,
        });
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function acquireFeed(endpoint: FeedEndpoint, options: AcquireOptions): Promise<AcquiredFeed> {
  const started = performance.now();
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const sleep = options.sleep ?? wait;
  const random = options.random ?? Math.random;
  let attempt = 0;
  while (attempt < 2) {
    attempt += 1;
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
    const signal = options.signal === undefined
      ? timeoutSignal
      : AbortSignal.any([options.signal, timeoutSignal]);
    try {
      const response = await fetchImplementation(endpoint.url, {
        signal,
        headers: { accept: 'application/x-protobuf, application/octet-stream' },
      });
      if (response.status >= 400 && response.status < 500) {
        throw new FeedAcquisitionError({
          code: 'http_4xx', message: `Feed returned HTTP ${response.status}`,
          status: response.status, attempts: attempt, durationMs: Math.round(performance.now() - started),
        });
      }
      if (response.status >= 500) {
        if (attempt < 2) {
          await sleep(3_000 + Math.floor(random() * 2_001));
          continue;
        }
        throw new FeedAcquisitionError({
          code: 'http_5xx', message: `Feed returned HTTP ${response.status}`,
          status: response.status, attempts: attempt, durationMs: Math.round(performance.now() - started),
        });
      }
      if (!response.ok) {
        throw new FeedAcquisitionError({
          code: 'network_error', message: `Feed returned HTTP ${response.status}`,
          status: response.status, attempts: attempt, durationMs: Math.round(performance.now() - started),
        });
      }
      let body: Uint8Array;
      try {
        body = await boundedBody(response, options.maxResponseBytes);
      } catch (error) {
        if (error instanceof FeedAcquisitionError) {
          throw new FeedAcquisitionError({
            code: error.code, message: error.message, status: response.status,
            attempts: attempt, durationMs: Math.round(performance.now() - started),
          });
        }
        throw error;
      }
      return {
        body, status: response.status, responseBytes: body.byteLength,
        durationMs: Math.round(performance.now() - started), attempts: attempt,
      };
    } catch (error) {
      if (error instanceof FeedAcquisitionError) throw error;
      const timedOut = timeoutSignal.aborted && !(options.signal?.aborted ?? false);
      if (attempt < 2 && !(options.signal?.aborted ?? false)) {
        await sleep(3_000 + Math.floor(random() * 2_001));
        continue;
      }
      throw new FeedAcquisitionError({
        code: timedOut ? 'timeout' : 'network_error',
        message: timedOut ? 'Feed request timed out' : 'Feed request failed',
        attempts: attempt,
        durationMs: Math.round(performance.now() - started),
      });
    }
  }
  throw new FeedAcquisitionError({
    code: 'network_error', message: 'Feed request failed', attempts: attempt,
    durationMs: Math.round(performance.now() - started),
  });
}
