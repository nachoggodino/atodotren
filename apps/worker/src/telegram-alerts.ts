import type { ReportingService } from './reporting-service.js';
import type { TelegramOperationsConfig } from './telegram-config.js';
import type { TelegramStateStore, DeliveryRecord } from './telegram-state.js';
import type { TelegramBotApi } from './telegram-transport.js';

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
  'spool.shedding',
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
        text: `ACTIVE · ${incident.incident_key}\nOpened ${new Date(incident.opened_at).toISOString()} · observations ${incident.occurrence_count}\nUse /status and /incidents for bounded detail.`,
        ...options,
      });
      continue;
    }
    const active = await options.state.delivery(activeKey);
    if (active?.delivered !== true) continue;
    await deliverOnce({
      key: `incident:recovery:${episode}`,
      type: 'incident_recovery',
      text: `RECOVERY · ${incident.incident_key}\nOpened ${new Date(incident.opened_at).toISOString()} · recovered ${incident.recovered_at === null ? 'n/a' : new Date(incident.recovered_at).toISOString()}\nUse /incidents for recent episodes.`,
      ...options,
    });
  }
}

function eligible(incident: IncidentRow, config: TelegramOperationsConfig, now: Date): boolean {
  if (immediateCriticalKeys.has(incident.incident_key)) return true;
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
  if (existing?.delivered === true || !retryDue(existing, options.now)) return;
  const reserved = await options.state.beginDelivery({ key: options.key, type: options.type });
  if (reserved.delivered || reserved.attempts > 8) return;
  try {
    const sent = await options.telegram.sendMessage(options.config.privateChatId ?? '', options.text, { disableNotification: false }, options.signal);
    await options.state.markDelivered(options.key, sent.message_id);
  } catch (error) {
    await options.state.markFailed(options.key, error instanceof Error ? error.name : 'DeliveryError');
  }
}

function retryDue(record: DeliveryRecord | null, now: Date): boolean {
  if (record === null || record.lastAttemptAt === null) return true;
  const exponent = Math.max(0, Math.min(6, record.attempts - 1));
  const delayMs = Math.min(300_000, 5_000 * 2 ** exponent);
  return now.getTime() - record.lastAttemptAt.getTime() >= delayMs;
}
