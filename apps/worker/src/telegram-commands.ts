import { parseReportDate, type ChartSpec } from './reporting-core.js';
import {
  formatReportText,
  incidentsReport,
  pilotReport,
  statusReport,
  trainReport,
  trainsReport,
} from './reporting-operations.js';
import type { ReportingService } from './reporting-service.js';
import { formatResources, type ResourceCollector } from './resources.js';
import type { TelegramStateStore } from './telegram-state.js';
import type { InlineButton } from './telegram-transport.js';

export type ParsedCommand =
  | { readonly name: 'status' | 'incidents' | 'resources' | 'pilot' | 'help' }
  | { readonly name: 'daily'; readonly date?: string }
  | { readonly name: 'line' | 'station'; readonly query: string; readonly date?: string }
  | { readonly name: 'trains'; readonly query: string }
  | { readonly name: 'train'; readonly trainId: string };

export interface CommandResponse {
  readonly text: string;
  readonly buttons?: readonly (readonly InlineButton[])[];
  readonly chart?: ChartSpec;
}

export const telegramHelp = `Atodotren operations bot
/status
/daily [YYYY-MM-DD|yesterday]
/line <name> [date]
/station <name> [date]
/trains <line>
/train <id>
/incidents
/resources
/pilot
/help

Examples: /daily yesterday · /line C-1 2026-08-22 · /station Atocha`;

export function parseTelegramCommand(text: string, now: Date = new Date()): ParsedCommand {
  const compact = text.trim().replace(/\s+/gu, ' ');
  if (compact.length < 1 || compact.length > 300) throw new RangeError('Command must contain 1 through 300 characters');
  const tokens = compact.split(' ');
  const commandMatch = /^\/([a-z]+)(?:@[A-Za-z0-9_]+)?$/u.exec(tokens[0] ?? '');
  if (commandMatch === null) throw new RangeError('Use /help for supported commands');
  const name = commandMatch[1] ?? '';
  const args = tokens.slice(1);
  if (['status', 'incidents', 'resources', 'pilot', 'help'].includes(name)) {
    if (args.length > 0) throw new RangeError(`/${name} does not accept arguments`);
    return { name: name as 'status' | 'incidents' | 'resources' | 'pilot' | 'help' };
  }
  if (name === 'daily') {
    if (args.length > 1) throw new RangeError('/daily accepts at most one date');
    const date = args[0] === undefined ? undefined : parseReportDate(args[0], now);
    return { name: 'daily', ...(date === undefined ? {} : { date }) };
  }
  if (name === 'line' || name === 'station') {
    if (args.length < 1) throw new RangeError(`/${name} requires a name`);
    const last = args.at(-1);
    const hasDate = last === 'yesterday' || /^\d{4}-\d{2}-\d{2}$/u.test(last ?? '');
    const date = hasDate && last !== undefined ? parseReportDate(last, now) : undefined;
    const query = args.slice(0, hasDate ? -1 : undefined).join(' ').trim();
    if (query.length < 1 || query.length > 100) throw new RangeError(`/${name} name must contain 1 through 100 characters`);
    return { name, query, ...(date === undefined ? {} : { date }) };
  }
  if (name === 'trains') {
    const query = args.join(' ').trim();
    if (query.length < 1 || query.length > 100) throw new RangeError('/trains requires a bounded line name');
    return { name: 'trains', query };
  }
  if (name === 'train') {
    const trainId = args.join(' ').trim();
    if (trainId.length < 1 || trainId.length > 110) throw new RangeError('/train requires the id returned by /trains');
    return { name: 'train', trainId };
  }
  throw new RangeError(`Unknown command /${name}; use /help`);
}

export async function executeTelegramCommand(options: {
  readonly command: ParsedCommand;
  readonly reporting: ReportingService;
  readonly resources: ResourceCollector;
  readonly state: TelegramStateStore;
}): Promise<CommandResponse> {
  const { command, reporting, resources, state } = options;
  if (command.name === 'help') return { text: telegramHelp };
  if (command.name === 'status') return { text: bounded(formatReportText(await statusReport(reporting))) };
  if (command.name === 'incidents') return { text: bounded(formatReportText(await incidentsReport(reporting))) };
  if (command.name === 'pilot') return { text: bounded(formatReportText(await pilotReport(reporting))) };
  if (command.name === 'resources') {
    const sample = await resources.collect();
    return { text: bounded(formatResources(sample, resources.trend())) };
  }
  if (command.name === 'daily') {
    const [daily, status] = await Promise.all([reporting.daily(command.date), statusReport(reporting)]);
    const technical = `Technical: ingestion incidents ${status.openIncidents}; bot monitors ${status.openMonitorEpisodes.length}; ingestion ${briefHealth(status.ingestion)}`;
    return { text: bounded(`${formatReportText(daily)}\n${technical}`), chart: daily.chart };
  }
  if (command.name === 'train') return { text: bounded(formatReportText(await trainReport(reporting, command.trainId))) };
  if (command.name === 'line') {
    const candidates = await reporting.lineCandidates(command.query);
    const selected = exactOrUnique(candidates);
    if (selected === null) return candidateResponse('line', candidates, command.date ?? null, state);
    const report = await reporting.line(selected.id, command.date);
    return report === null ? { text: `No aggregate data is available for ${selected.label} on that service date.` } : { text: bounded(formatReportText(report)), chart: report.chart };
  }
  if (command.name === 'station') {
    const candidates = await reporting.stationCandidates(command.query);
    const selected = exactOrUnique(candidates);
    if (selected === null) return candidateResponse('station', candidates, command.date ?? null, state);
    const report = await reporting.station(selected.id, command.date);
    return report === null ? { text: `No aggregate data is available for ${selected.label} on that service date.` } : { text: bounded(formatReportText(report)), chart: report.chart };
  }
  if (command.name !== 'trains') throw new Error('Command routing reached an impossible state');
  const candidates = await reporting.lineCandidates(command.query);
  const selected = exactOrUnique(candidates);
  if (selected === null) return candidateResponse('line', candidates, null, state, true);
  const report = await trainsReport(reporting, selected.id);
  if (report === null) return { text: `Unknown line ${command.query}.` };
  const buttons: InlineButton[][] = [];
  for (const train of report.trains.slice(0, 10)) {
    const callbackId = await state.createCallback({ kind: 'train', entityId: train.trainId, reportDate: null });
    buttons.push([{ text: `${train.trainId} · ${train.station ?? 'station n/a'}`, callback_data: `r:${callbackId}` }]);
  }
  return { text: bounded(formatReportText(report)), ...(buttons.length === 0 ? {} : { buttons }) };
}

export async function executeCallback(options: {
  readonly callbackData: string;
  readonly reporting: ReportingService;
  readonly state: TelegramStateStore;
}): Promise<CommandResponse> {
  const match = /^r:([A-Za-z0-9_-]{8,48})$/u.exec(options.callbackData);
  if (match === null) return { text: 'This selection is invalid or expired.' };
  const target = await options.state.readCallback(match[1] ?? '');
  if (target === null) return { text: 'This selection has expired. Run the command again.' };
  if (target.kind === 'train') return { text: bounded(formatReportText(await trainReport(options.reporting, target.entityId))) };
  const id = Number(target.entityId);
  if (!Number.isSafeInteger(id) || id <= 0) return { text: 'This selection is invalid.' };
  if (target.kind === 'line') {
    const report = await options.reporting.line(id, target.reportDate ?? undefined);
    return report === null ? { text: 'No aggregate data is available for that line/date.' } : { text: bounded(formatReportText(report)), chart: report.chart };
  }
  const report = await options.reporting.station(id, target.reportDate ?? undefined);
  return report === null ? { text: 'No aggregate data is available for that station/date.' } : { text: bounded(formatReportText(report)), chart: report.chart };
}

async function candidateResponse(
  kind: 'line' | 'station',
  candidates: readonly { readonly id: number; readonly label: string; readonly code?: string }[],
  reportDate: string | null,
  state: TelegramStateStore,
  trains = false,
): Promise<CommandResponse> {
  if (candidates.length === 0) return { text: `No matching ${kind} was found.` };
  const buttons: InlineButton[][] = [];
  for (const candidate of candidates.slice(0, 5)) {
    const callbackId = await state.createCallback({ kind, entityId: String(candidate.id), reportDate });
    buttons.push([{ text: `${candidate.code === undefined ? '' : `${candidate.code} · `}${candidate.label}`, callback_data: `r:${callbackId}` }]);
  }
  return {
    text: trains ? 'Line is ambiguous. Select the intended line, then run /trains for it.' : `Ambiguous ${kind}. Select one:`,
    buttons,
  };
}

function exactOrUnique<T extends { readonly score: number }>(candidates: readonly T[]): T | null {
  if (candidates.length === 1) return candidates[0] ?? null;
  if (candidates.length > 1 && candidates[0]?.score === 100 && candidates[1]?.score !== 100) return candidates[0] ?? null;
  return null;
}

function briefHealth(health: Readonly<Record<string, unknown>> | null): string {
  if (health === null) return 'unavailable';
  return `last durable ${displayScalar(health.last_durable_cycle_at)}, spool ${displayScalar(health.spool_pending_count)} pending`;
}

function displayScalar(value: unknown): string {
  if (value === null || value === undefined) return 'n/a';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value.toString();
  return 'unavailable';
}

function bounded(text: string): string {
  if (text.length <= 3_900) return text;
  return `${text.slice(0, 3_840)}\n… output bounded by the operations service`;
}
