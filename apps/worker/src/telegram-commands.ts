import { parseReportDate, type ChartSpec } from './reporting-core.js';
import {
  incidentsReport,
  pilotReport,
  statusReport,
  trainReport,
  trainsReport,
} from './reporting-operations.js';
import type { ReportingService } from './reporting-service.js';
import type { ResourceCollector } from './resources.js';
import {
  escapeTelegramHtml,
  formatTelegramInstant,
  formatTelegramReport,
  formatTelegramResources,
  telegramHelpText,
} from './telegram-format.js';
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
  readonly parseMode?: 'HTML';
  readonly buttons?: readonly (readonly InlineButton[])[];
  readonly chart?: ChartSpec;
}

export const telegramHelp = telegramHelpText();

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
  if (command.name === 'help') return html(telegramHelp);
  if (command.name === 'status') return html(formatTelegramReport(await statusReport(reporting)));
  if (command.name === 'incidents') return html(formatTelegramReport(await incidentsReport(reporting)));
  if (command.name === 'pilot') return html(formatTelegramReport(await pilotReport(reporting)));
  if (command.name === 'resources') {
    const sample = await resources.collect();
    await state.recordResourceSample(sample);
    return html(formatTelegramResources(sample, resources.trend()));
  }
  if (command.name === 'daily') {
    const [daily, status] = await Promise.all([reporting.daily(command.date), statusReport(reporting)]);
    const technical = `<b>Technical</b>\n${status.openIncidents === 0 ? '🟢' : '🔴'} Ingestion incidents: <b>${status.openIncidents}</b> · bot monitors: <b>${status.openMonitorEpisodes.length}</b>\n${briefHealth(status.ingestion)}`;
    return { ...html(`${formatTelegramReport(daily)}\n\n${technical}`), chart: daily.chart };
  }
  if (command.name === 'train') return html(formatTelegramReport(await trainReport(reporting, command.trainId)));
  if (command.name === 'line') {
    const candidates = await reporting.lineCandidates(command.query);
    const selected = exactOrUnique(candidates);
    if (selected === null) return candidateResponse('line', candidates, command.date ?? null, state, 'report');
    const report = await reporting.line(selected.id, command.date);
    return report === null ? html(`⚪ No aggregate data is available for <b>${escapeTelegramHtml(selected.label)}</b> on that service date.`) : { ...html(formatTelegramReport(report)), chart: report.chart };
  }
  if (command.name === 'station') {
    const candidates = await reporting.stationCandidates(command.query);
    const selected = exactOrUnique(candidates);
    if (selected === null) return candidateResponse('station', candidates, command.date ?? null, state, 'report');
    const report = await reporting.station(selected.id, command.date);
    return report === null ? html(`⚪ No aggregate data is available for <b>${escapeTelegramHtml(selected.label)}</b> on that service date.`) : { ...html(formatTelegramReport(report)), chart: report.chart };
  }
  if (command.name !== 'trains') throw new Error('Command routing reached an impossible state');
  const candidates = await reporting.lineCandidates(command.query);
  const selected = exactOrUnique(candidates);
  if (selected === null) return candidateResponse('line', candidates, null, state, 'trains');
  return trainsResponse(reporting, state, selected.id, command.query);
}

export async function executeCallback(options: {
  readonly callbackData: string;
  readonly reporting: ReportingService;
  readonly state: TelegramStateStore;
}): Promise<CommandResponse> {
  const match = /^r:([A-Za-z0-9_-]{8,48})$/u.exec(options.callbackData);
  if (match === null) return html('⚪ This selection is invalid or expired.');
  const target = await options.state.readCallback(match[1] ?? '');
  if (target === null) return html('⚪ This selection has expired. Run the command again.');
  if (target.kind === 'train') return html(formatTelegramReport(await trainReport(options.reporting, target.entityId)));
  const id = Number(target.entityId);
  if (!Number.isSafeInteger(id) || id <= 0) return html('⚪ This selection is invalid.');
  if (target.kind === 'line') {
    if (target.action === 'trains') return trainsResponse(options.reporting, options.state, id, `line ${id}`);
    const report = await options.reporting.line(id, target.reportDate ?? undefined);
    return report === null ? html('⚪ No aggregate data is available for that line/date.') : { ...html(formatTelegramReport(report)), chart: report.chart };
  }
  const report = await options.reporting.station(id, target.reportDate ?? undefined);
  return report === null ? html('⚪ No aggregate data is available for that station/date.') : { ...html(formatTelegramReport(report)), chart: report.chart };
}

async function trainsResponse(
  reporting: ReportingService,
  state: TelegramStateStore,
  lineId: number,
  requested: string,
): Promise<CommandResponse> {
  const report = await trainsReport(reporting, lineId);
  if (report === null) return html(`⚪ Unknown line <b>${escapeTelegramHtml(requested)}</b>.`);
  if (report.trains.length === 0) {
    return html(`⚪ No fresh trains are available for <b>${escapeTelegramHtml(report.line.code)}</b>. Realtime ingestion may be stale or Renfe may not be reporting vehicles.`);
  }
  const buttons: InlineButton[][] = [];
  for (const train of report.trains.slice(0, 10)) {
    const callbackId = await state.createCallback({ action: 'report', kind: 'train', entityId: train.trainId, reportDate: null });
    buttons.push([{ text: `${train.trainId} · ${train.station ?? 'station n/a'}`, callback_data: `r:${callbackId}` }]);
  }
  return { ...html(formatTelegramReport(report)), ...(buttons.length === 0 ? {} : { buttons }) };
}

async function candidateResponse(
  kind: 'line' | 'station',
  candidates: readonly { readonly id: number; readonly label: string; readonly code?: string }[],
  reportDate: string | null,
  state: TelegramStateStore,
  action: 'report' | 'trains',
): Promise<CommandResponse> {
  if (candidates.length === 0) return html(`⚪ No matching ${kind} was found.`);
  const buttons: InlineButton[][] = [];
  for (const candidate of candidates.slice(0, 5)) {
    const callbackId = await state.createCallback({ action, kind, entityId: String(candidate.id), reportDate });
    buttons.push([{ text: `${candidate.code === undefined ? '' : `${candidate.code} · `}${candidate.label}`, callback_data: `r:${callbackId}` }]);
  }
  return {
    ...html(action === 'trains' ? '🔎 <b>Several lines match.</b> Select one:' : `🔎 <b>Several ${kind}s match.</b> Select one:`),
    buttons,
  };
}

function exactOrUnique<T extends { readonly score: number }>(candidates: readonly T[]): T | null {
  if (candidates.length === 1) return candidates[0] ?? null;
  if (candidates.length > 1 && candidates[0]?.score === 100 && candidates[1]?.score !== 100) return candidates[0] ?? null;
  return null;
}

function briefHealth(health: Readonly<Record<string, unknown>> | null): string {
  if (health === null) return '⚪ Ingestion health unavailable';
  return `Latest durable cycle: <b>${formatTelegramInstant(health.last_durable_cycle_at)}</b> · spool <b>${escapeTelegramHtml(displayScalar(health.spool_pending_count))} pending</b>`;
}

function displayScalar(value: unknown): string {
  if (value === null || value === undefined) return 'n/a';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value.toString();
  return 'unavailable';
}

function html(text: string): CommandResponse {
  if (text.length > 3_900) throw new RangeError('Formatted Telegram response exceeds the bounded service limit');
  return { text, parseMode: 'HTML' };
}
