import type { ReportingService } from './reporting-service.js';
import type { TelegramOperationsConfig } from './telegram-config.js';
import {
  TELEGRAM_DELIVERY_MAX_ATTEMPTS,
  telegramDeliveryAbandoned,
  telegramDeliveryRetryWait,
} from './telegram-delivery-retry.js';
import type { TelegramStateStore } from './telegram-state.js';
import type { TelegramBotApi } from './telegram-transport.js';
import { formatTelegramIncident } from './telegram-format.js';

interface IncidentRow {
  readonly incident_key: string;
  readonly opened_at: Date | string;
  readonly last_observed_at: Date | string;
  readonly occurrence_count: number | string;
  readonly is_open: boolean;
  readonly recovered_at: Date | string | null;
}

const immediateCriticalKeys = new Set([
  'ingest.repeated_failure',
  'ingest.matching_collapse',
  'ingest.malformed_spike',
  'spool.replay_failure',
  'static.version_mismatch',
]);

export function shouldDeliverIngestionIncident(incidentKey: string): boolean {
  // ingest.stale is deliberately delivered only by the independent Telegram
  // watchdog. The worker-owned incident remains read-only evidence/context.
  return incidentKey !== 'ingest.stale';
}

export async function deliverIngestionIncidents(options: {
  readonly config: TelegramOperationsConfig;
  readonly reporting: ReportingService;
  readonly state: TelegramStateStore;
  readonly telegram: TelegramBotApi;
  readonly now: Date;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const result = await options.reporting.pool.query<IncidentRow>(`SELECT * FROM operations.report_incident_episode
    WHERE is_open OR recovered_at >= clock_timestamp() - interval '48 hours'
    ORDER BY last_observed_at DESC LIMIT 50`);
  for (const incident of result.rows) {
    if (!shouldDeliverIngestionIncident(incident.incident_key) || !eligible(incident, options.config, options.now)) continue;
    const episode = `${incident.incident_key}:${new Date(incident.opened_at).toISOString()}`;
    const activeKey = `incident:active:${episode}`;
    if (incident.is_open) {
      await deliverOnce({
        key: activeKey,
        type: 'incident_active',
        text: formatTelegramIncident({ active: true, key: incident.incident_key, openedAt: incident.opened_at, observations: incident.occurrence_count }),
        ...options,
      });
      continue;
    }
    const active = await options.state.delivery(activeKey);
    if (active?.delivered !== true) continue;
    await deliverOnce({
      key: `incident:recovery:${episode}`,
      type: 'incident_recovery',
      text: formatTelegramIncident({ active: false, key: incident.incident_key, openedAt: incident.opened_at, recoveredAt: incident.recovered_at }),
      ...options,
    });
  }
}

function eligible(incident: IncidentRow, config: TelegramOperationsConfig, now: Date): boolean {
  if (incident.incident_key === 'spool.shedding') return true;
  if (immediateCriticalKeys.has(incident.incident_key)) {
    return Number(incident.occurrence_count) >= config.thresholds.ingestionIncidentConsecutive;
  }
  if (incident.incident_key === 'spool.growth') {
    return now.getTime() - new Date(incident.opened_at).getTime() >= config.thresholds.spoolBacklogMs;
  }
  return false;
}

async function deliverOnce(options: {
  readonly key: string;
  readonly type: 'incident_active' | 'incident_recovery';
  readonly text: string;
  readonly config: TelegramOperationsConfig;
  readonly state: TelegramStateStore;
  readonly telegram: TelegramBotApi;
  readonly now: Date;
  readonly signal?: AbortSignal;
  readonly reporting: ReportingService;
}): Promise<void> {
  const existing = await options.state.delivery(options.key);
  if (existing?.delivered === true || telegramDeliveryAbandoned(existing)) return;
  const retryWaitMs = telegramDeliveryRetryWait(existing, options.now);
  if (retryWaitMs !== null && retryWaitMs > 0) return;
  const reserved = await options.state.beginDelivery({ key: options.key, type: options.type });
  if (reserved.delivered || reserved.attempts > TELEGRAM_DELIVERY_MAX_ATTEMPTS) return;
  try {
    const sent = await options.telegram.sendMessage(options.config.privateChatId ?? '', options.text, { disableNotification: false, parseMode: 'HTML' }, options.signal);
    await options.state.markDelivered(options.key, sent.message_id);
  } catch (error) {
    await options.state.markFailed(options.key, error instanceof Error ? error.name : 'DeliveryError');
  }
}
