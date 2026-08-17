import type { Pool } from 'pg';

export const RENFE_STATIC_URL =
  'https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip';

export interface StaticImportLimits {
  readonly maxArchiveBytes: number;
  readonly maxEntryBytes: number;
  readonly maxStopTimesEntryBytes: number;
  readonly maxTotalUncompressedBytes: number;
  readonly maxEntries: number;
  readonly maxRowBytes: number;
  readonly maxRetainedStopTimes: number;
  readonly requestTimeoutMs: number;
  readonly maxRedirects: number;
}

export const defaultStaticImportLimits: StaticImportLimits = {
  maxArchiveBytes: 256 * 1024 * 1024,
  maxEntryBytes: 512 * 1024 * 1024,
  maxStopTimesEntryBytes: 1024 * 1024 * 1024,
  maxTotalUncompressedBytes: 1536 * 1024 * 1024,
  maxEntries: 64,
  maxRowBytes: 1024 * 1024,
  maxRetainedStopTimes: 750_000,
  requestTimeoutMs: 60_000,
  maxRedirects: 3,
};

export interface MadridRouteRule {
  readonly id: string;
  readonly routeIdPrefixes: readonly string[];
}

export interface ImportCanaries {
  readonly requiredLineCodes: readonly string[];
  readonly requiredStationPublicIds: readonly string[];
  readonly minimumStations: number;
  readonly minimumTrips: number;
  readonly requireReferencedShapes: boolean;
}

export interface MadridMappingConfig {
  readonly networkSlug: 'madrid';
  readonly timezone: 'Europe/Madrid';
  readonly sourceAgencyIds: readonly string[];
  readonly routeRules: readonly MadridRouteRule[];
  readonly stationAliases: Readonly<Record<string, string>>;
  readonly canaries: ImportCanaries;
}

export const renfeMadridMapping: MadridMappingConfig = {
  networkSlug: 'madrid',
  timezone: 'Europe/Madrid',
  sourceAgencyIds: ['1071VC'],
  routeRules: [
    {
      id: 'renfe-cercanias-madrid-route-prefix-10',
      routeIdPrefixes: ['10'],
    },
  ],
  stationAliases: {},
  canaries: {
    requiredLineCodes: [],
    requiredStationPublicIds: [],
    minimumStations: 2,
    minimumTrips: 1,
    requireReferencedShapes: true,
  },
};

export type ImportFailureKind =
  | 'configuration'
  | 'acquisition'
  | 'timeout'
  | 'http'
  | 'archive'
  | 'csv'
  | 'validation'
  | 'database'
  | 'interrupted';

export class StaticImportError extends Error {
  public readonly kind: ImportFailureKind;
  public readonly code: string;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    kind: ImportFailureKind,
    code: string,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'StaticImportError';
    this.kind = kind;
    this.code = code;
    this.details = details;
  }
}

export interface EntityCounts {
  readonly routes: number;
  readonly trips: number;
  readonly stops: number;
  readonly stopTimes: number;
  readonly calendarServices: number;
  readonly calendarExceptions: number;
  readonly shapes: number;
  readonly shapePoints: number;
}

export interface StaticImportReport {
  readonly ok: boolean;
  readonly result: 'imported' | 'unchanged' | 'rejected';
  readonly source: { readonly kind: 'http' | 'file'; readonly display: string };
  readonly fetch: {
    readonly status: 'downloaded' | 'local' | 'not-modified' | 'checksum-match' | 'failed';
    readonly httpStatus?: number;
    readonly etag?: string;
    readonly lastModified?: string;
    readonly archiveBytes?: number;
    readonly durationMs: number;
  };
  readonly checksum?: string;
  readonly feedVersionId?: string;
  readonly feedVersionStatus?: string;
  readonly parsed?: EntityCounts;
  readonly retained?: EntityCounts;
  readonly discarded?: EntityCounts;
  readonly dimensions?: {
    readonly stations: number;
    readonly lines: number;
    readonly branches: number;
    readonly servicePatterns: number;
    readonly segments: number;
  };
  readonly mappingCoverage?: { readonly trips: number; readonly stops: number; readonly routes: number };
  readonly warnings: readonly string[];
  readonly rejectionCount: number;
  readonly activation: 'activated' | 'unchanged' | 'not-attempted';
  readonly previousVersionId?: string;
  readonly currentVersionId?: string;
  readonly timingsMs: Readonly<Record<string, number>>;
  readonly totalDurationMs: number;
  readonly error?: { readonly kind: ImportFailureKind; readonly code: string; readonly message: string };
}

export interface ImportStaticOptions {
  readonly pool: Pool;
  readonly source: { readonly kind: 'http'; readonly url: string } | { readonly kind: 'file'; readonly path: string };
  readonly forceRecheck?: boolean;
  readonly signal?: AbortSignal;
  readonly limits?: Partial<StaticImportLimits>;
  readonly mapping?: MadridMappingConfig;
  readonly temporaryDirectory?: string;
  readonly now?: () => Date;
}

export interface ActiveFeedMetadata {
  readonly id: string;
  readonly sourceUrl: string;
  readonly sha256: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly activatedAt: Date;
}
