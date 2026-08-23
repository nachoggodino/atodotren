import { readFile, stat, statfs } from 'node:fs/promises';

import type { ReportingService } from './reporting-service.js';

export interface Measurement<T> {
  readonly available: boolean;
  readonly value?: T;
  readonly reason?: string;
}

export interface ResourceSample {
  readonly generatedAt: string;
  readonly telegramProcessCpuRatio: Measurement<number>;
  readonly telegramProcessRssBytes: Measurement<number>;
  readonly telegramContainerMemoryRatio: Measurement<number>;
  readonly workerContainerCpuRatio: Measurement<number>;
  readonly workerContainerMemoryRatio: Measurement<number>;
  readonly spoolBytes: Measurement<number>;
  readonly spoolFreeRatio: Measurement<number>;
  readonly databaseBytes: Measurement<number>;
  readonly databaseBreakdown: Readonly<Record<string, number>>;
  readonly hostCpuRatio: Measurement<number>;
  readonly hostMemoryRatio: Measurement<number>;
  readonly hostDiskFreeRatio: Measurement<number>;
}

interface CpuSnapshot {
  readonly usage: NodeJS.CpuUsage;
  readonly atMs: number;
}

export class ResourceCollector {
  readonly #reporting: ReportingService;
  readonly #spoolPath: string;
  readonly #hostMetrics: { readonly enabled: boolean; readonly procPath?: string; readonly rootPath?: string };
  readonly #trend: ResourceSample[] = [];
  #previousCpu?: CpuSnapshot;
  #previousHostCpu?: { readonly idle: number; readonly total: number };

  public constructor(options: {
    readonly reporting: ReportingService;
    readonly spoolPath?: string;
    readonly hostMetrics?: { readonly enabled: boolean; readonly procPath?: string; readonly rootPath?: string };
  }) {
    this.#reporting = options.reporting;
    this.#spoolPath = options.spoolPath ?? '/spool/realtime.sqlite';
    this.#hostMetrics = options.hostMetrics ?? { enabled: false };
  }

  public trend(): readonly ResourceSample[] {
    return [...this.#trend];
  }

  public async collect(): Promise<ResourceSample> {
    const now = new Date();
    const cpu = process.cpuUsage();
    const atMs = performance.now();
    let cpuRatio: Measurement<number> = unavailable('requires a second sample');
    if (this.#previousCpu !== undefined) {
      const elapsedUs = Math.max(1, (atMs - this.#previousCpu.atMs) * 1_000);
      const usedUs = (cpu.user - this.#previousCpu.usage.user) + (cpu.system - this.#previousCpu.usage.system);
      cpuRatio = available(Math.max(0, usedUs / elapsedUs));
    }
    this.#previousCpu = { usage: cpu, atMs };

    const rss = available(process.memoryUsage().rss);
    const [containerMemory, spool, database, host] = await Promise.all([
      readContainerMemory(),
      readSpool(this.#spoolPath),
      readDatabase(this.#reporting),
      readHost(this.#hostMetrics, this.#previousHostCpu),
    ]);
    this.#previousHostCpu = host.snapshot ?? this.#previousHostCpu;
    const sample: ResourceSample = {
      generatedAt: now.toISOString(),
      telegramProcessCpuRatio: cpuRatio,
      telegramProcessRssBytes: rss,
      telegramContainerMemoryRatio: containerMemory,
      workerContainerCpuRatio: unavailable('separate container metrics are unavailable without privileged/Docker-socket access'),
      workerContainerMemoryRatio: unavailable('separate container metrics are unavailable without privileged/Docker-socket access'),
      spoolBytes: spool.bytes,
      spoolFreeRatio: spool.freeRatio,
      databaseBytes: database.total,
      databaseBreakdown: database.breakdown,
      hostCpuRatio: host.cpu,
      hostMemoryRatio: host.memory,
      hostDiskFreeRatio: host.disk,
    };
    this.#trend.push(sample);
    if (this.#trend.length > 12) this.#trend.splice(0, this.#trend.length - 12);
    return sample;
  }
}

function available<T>(value: T): Measurement<T> {
  return { available: true, value };
}

function unavailable<T>(reason: string): Measurement<T> {
  return { available: false, reason };
}

async function readContainerMemory(): Promise<Measurement<number>> {
  try {
    const [currentRaw, maxRaw] = await Promise.all([
      readFile('/sys/fs/cgroup/memory.current', 'utf8'),
      readFile('/sys/fs/cgroup/memory.max', 'utf8'),
    ]);
    const current = Number(currentRaw.trim());
    const max = maxRaw.trim() === 'max' ? Number.NaN : Number(maxRaw.trim());
    return Number.isFinite(current) && Number.isFinite(max) && max > 0
      ? available(current / max)
      : unavailable('container memory limit is not finite');
  } catch {
    return unavailable('cgroup v2 memory counters are unavailable');
  }
}

async function readSpool(path: string): Promise<{ readonly bytes: Measurement<number>; readonly freeRatio: Measurement<number> }> {
  let bytes: Measurement<number>;
  try {
    bytes = available((await stat(path)).size);
  } catch {
    bytes = unavailable('spool file is unavailable');
  }
  try {
    const filesystem = await statfs(path.replace(/\/[^/]+$/u, '') || '/');
    const total = Number(filesystem.blocks) * Number(filesystem.bsize);
    const free = Number(filesystem.bavail) * Number(filesystem.bsize);
    return { bytes, freeRatio: total > 0 ? available(free / total) : unavailable('spool filesystem capacity is unavailable') };
  } catch {
    return { bytes, freeRatio: unavailable('spool filesystem capacity is unavailable') };
  }
}

async function readDatabase(reporting: ReportingService): Promise<{
  readonly total: Measurement<number>;
  readonly breakdown: Readonly<Record<string, number>>;
}> {
  try {
    const result = await reporting.pool.query('SELECT * FROM operations.report_database_size LIMIT 1');
    const row = result.rows[0];
    if (row === undefined) return { total: unavailable('database size view returned no row'), breakdown: {} };
    const total = Number(row.database_bytes);
    const keys = ['poll_run_bytes', 'stop_evidence_bytes', 'journey_bytes', 'daily_aggregate_bytes'] as const;
    return {
      total: Number.isFinite(total) ? available(total) : unavailable('database size is not numeric'),
      breakdown: Object.fromEntries(keys.map((key) => [key, Number(row[key])]).filter((entry) => Number.isFinite(entry[1]))),
    };
  } catch {
    return { total: unavailable('database size query failed'), breakdown: {} };
  }
}

async function readHost(
  config: { readonly enabled: boolean; readonly procPath?: string; readonly rootPath?: string },
  previous?: { readonly idle: number; readonly total: number },
): Promise<{
  readonly cpu: Measurement<number>;
  readonly memory: Measurement<number>;
  readonly disk: Measurement<number>;
  readonly snapshot?: { readonly idle: number; readonly total: number };
}> {
  if (!config.enabled || config.procPath === undefined || config.rootPath === undefined) {
    return { cpu: unavailable('optional host metrics mode is disabled'), memory: unavailable('optional host metrics mode is disabled'), disk: unavailable('optional host metrics mode is disabled') };
  }
  let cpu: Measurement<number> = unavailable('host CPU requires a second sample');
  let snapshot: { readonly idle: number; readonly total: number } | undefined;
  try {
    const first = (await readFile(`${config.procPath}/stat`, 'utf8')).split('\n')[0]?.trim().split(/\s+/u) ?? [];
    const values = first.slice(1).map(Number).filter(Number.isFinite);
    const idle = (values[3] ?? 0) + (values[4] ?? 0);
    const total = values.reduce((sum, value) => sum + value, 0);
    snapshot = { idle, total };
    if (previous !== undefined) {
      const totalDelta = total - previous.total;
      const idleDelta = idle - previous.idle;
      if (totalDelta > 0) cpu = available(Math.max(0, Math.min(1, 1 - idleDelta / totalDelta)));
    }
  } catch {
    cpu = unavailable('host /proc/stat read failed');
  }
  let memory: Measurement<number>;
  try {
    const text = await readFile(`${config.procPath}/meminfo`, 'utf8');
    const map = new Map(text.split('\n').map((line) => {
      const match = /^(\w+):\s+(\d+)/u.exec(line);
      return match === null ? ['', 0] : [match[1], Number(match[2])];
    }));
    const total = map.get('MemTotal') ?? 0;
    const availableMemory = map.get('MemAvailable') ?? 0;
    memory = total > 0 ? available(1 - availableMemory / total) : unavailable('host memory counters are invalid');
  } catch {
    memory = unavailable('host /proc/meminfo read failed');
  }
  let disk: Measurement<number>;
  try {
    const filesystem = await statfs(config.rootPath);
    const total = Number(filesystem.blocks) * Number(filesystem.bsize);
    const free = Number(filesystem.bavail) * Number(filesystem.bsize);
    disk = total > 0 ? available(free / total) : unavailable('host disk capacity is invalid');
  } catch {
    disk = unavailable('host root filesystem read failed');
  }
  return { cpu, memory, disk, ...(snapshot === undefined ? {} : { snapshot }) };
}

export function formatResources(sample: ResourceSample, trend: readonly ResourceSample[]): string {
  const ratio = (measurement: Measurement<number>): string => measurement.available ? `${((measurement.value ?? 0) * 100).toFixed(1)}%` : `unavailable (${measurement.reason})`;
  const bytes = (measurement: Measurement<number>): string => measurement.available ? `${measurement.value ?? 0} B` : `unavailable (${measurement.reason})`;
  const first = trend[0];
  const dbDelta = first?.databaseBytes.available === true && sample.databaseBytes.available === true
    ? (sample.databaseBytes.value ?? 0) - (first.databaseBytes.value ?? 0)
    : null;
  return [
    `Resources ${sample.generatedAt}`,
    `telegram CPU ${ratio(sample.telegramProcessCpuRatio)} · RSS ${bytes(sample.telegramProcessRssBytes)} · container memory ${ratio(sample.telegramContainerMemoryRatio)}`,
    `worker CPU ${ratio(sample.workerContainerCpuRatio)} · memory ${ratio(sample.workerContainerMemoryRatio)}`,
    `spool ${bytes(sample.spoolBytes)} · disk free ${ratio(sample.spoolFreeRatio)}`,
    `database ${bytes(sample.databaseBytes)}${dbDelta === null ? '' : ` · short trend ${dbDelta >= 0 ? '+' : ''}${dbDelta} B`}`,
    `host CPU ${ratio(sample.hostCpuRatio)} · memory ${ratio(sample.hostMemoryRatio)} · disk free ${ratio(sample.hostDiskFreeRatio)}`,
  ].join('\n');
}
