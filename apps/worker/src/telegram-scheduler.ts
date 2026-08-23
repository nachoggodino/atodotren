import { currentMadridServiceDate, REPORT_TIMEZONE, shiftIsoDate } from './reporting-core.js';
import { formatReportText, statusReport } from './reporting-operations.js';
import type { ReportingService } from './reporting-service.js';
import { compactResourceSection, type ResourceCollector } from './resources.js';
import {
  classifyTelegramDeliveryFailure,
  telegramDeliveryAbandoned,
  telegramDeliveryRetryWait,
} from './telegram-delivery-retry.js';
import type { TelegramOperationsConfig } from './telegram-config.js';
import type { TelegramStateStore } from './telegram-state.js';
import type { TelegramBotApi } from './telegram-transport.js';

export type DigestDecision = 'before-readiness' | 'waiting-target' | 'waiting-finalization' | 'normal' | 'provisional';

export function madridMinuteOfDay(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: REPORT_TIMEZONE,
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const read = (type: 'hour' | 'minute'): number => Number(parts.find((item) => item.type === type)?.value ?? 0);
  return read('hour') * 60 + read('minute');
}

export function finalizationReadyByCutoff(
  finalizedAt: string | null,
  currentServiceDate: string,
  blockedMinute: number,
): boolean {
  if (finalizedAt === null) return false;
  const finalized = new Date(finalizedAt);
  if (Number.isNaN(finalized.getTime())) return false;
  const finalizedServiceDate = currentMadridServiceDate(finalized);
  if (finalizedServiceDate < currentServiceDate) return true;
  if (finalizedServiceDate > currentServiceDate) return false;
  return madridMinuteOfDay(finalized) < blockedMinute;
}

export function decideDigest(options: {
  readonly now: Date;
  readonly finalized: boolean;
  readonly readyMinute: number;
  readonly targetMinute: number;
  readonly blockedMinute: number;
}): DigestDecision {
  const minute = madridMinuteOfDay(options.now);
  if (minute < options.readyMinute) return 'before-readiness';
  if (minute < options.targetMinute) return 'waiting-target';
  if (options.finalized) return 'normal';
  if (minute < options.blockedMinute) return 'waiting-finalization';
  return 'provisional';
}

export async function runDigestCheck(options: {
  readonly now: Date;
  readonly config: TelegramOperationsConfig;
  readonly reporting: ReportingService;
  readonly resources: ResourceCollector;
  readonly state: TelegramStateStore;
  readonly telegram: TelegramBotApi;
  readonly signal?: AbortSignal;
}): Promise<DigestDecision> {
  const currentMinute = madridMinuteOfDay(options.now);
  if (currentMinute < options.config.digestReadyMinute) return 'before-readiness';
  const currentServiceDate = currentMadridServiceDate(options.now);
  const previousServiceDate = shiftIsoDate(currentServiceDate, -1);
  const daily = await options.reporting.daily(previousServiceDate);
  const verified = daily.finalization.status === 'verified';
  const finalizedForDecision = verified && (
    currentMinute < options.config.digestBlockedMinute
    || finalizationReadyByCutoff(daily.finalization.finalizedAt, currentServiceDate, options.config.digestBlockedMinute)
  );
  const decision = decideDigest({
    now: options.now,
    finalized: finalizedForDecision,
    readyMinute: options.config.digestReadyMinute,
    targetMinute: options.config.digestTargetMinute,
    blockedMinute: options.config.digestBlockedMinute,
  });
  if (!['normal', 'provisional'].includes(decision)) return decision;
  const deliveryKey = `digest:${previousServiceDate}:${options.config.reportVersion}`;
  const previous = await options.state.delivery(deliveryKey);
  if (previous?.delivered === true || telegramDeliveryAbandoned(previous)) return decision;
  const retryWaitMs = telegramDeliveryRetryWait(previous, options.now);
  if (retryWaitMs !== null && retryWaitMs > 0) return decision;
  const reserved = await options.state.beginDelivery({
    key: deliveryKey,
    type: decision === 'normal' ? 'digest_normal' : 'digest_provisional',
    serviceDate: previousServiceDate,
  });
  if (reserved.delivered) return decision;
  const [currentStatus, sample] = await Promise.all([
    statusReport(options.reporting),
    options.resources.collect(),
  ]);
  await options.state.recordResourceSample(sample, options.now);
  const heading = decision === 'normal' ? 'Daily operations digest' : 'PROVISIONAL / FINALIZATION BLOCKED';
  const resources = compactResourceSection(
    sample,
    currentStatus.ingestion,
    currentStatus.openIncidents,
    currentStatus.openMonitorEpisodes.length,
  );
  const text = `${heading}\n${formatReportText(daily)}\n${resources}\nNew service day ${currentServiceDate}: ${shortCurrentStatus(currentStatus.ingestion, currentStatus.openIncidents, currentStatus.openMonitorEpisodes.length)}`;
  try {
    const sent = await options.telegram.sendMessage(options.config.privateChatId ?? '', text.slice(0, 4_000), { disableNotification: false }, options.signal);
    await options.state.markDelivered(deliveryKey, sent.message_id);
  } catch (error) {
    const failure = classifyTelegramDeliveryFailure(error, reserved.attempts);
    await options.state.markFailed(deliveryKey, failure.failureClass);
    if (!failure.abandon) throw error;
  }
  return decision;
}

function shortCurrentStatus(
  ingestion: Readonly<Record<string, unknown>> | null,
  openIncidents: number,
  openMonitors: number,
): string {
  if (ingestion === null) return `ingestion unavailable; ${openIncidents} ingestion incident(s); ${openMonitors} bot monitor(s)`;
  return `last durable ${displayScalar(ingestion.last_durable_cycle_at)}; spool ${displayScalar(ingestion.spool_pending_count)} pending; ${openIncidents} ingestion incident(s); ${openMonitors} bot monitor(s)`;
}

function displayScalar(value: unknown): string {
  if (value === null || value === undefined) return 'n/a';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value.toString();
  return 'unavailable';
}
