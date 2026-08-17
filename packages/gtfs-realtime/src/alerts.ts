import nodemailer from 'nodemailer';
import type { Pool } from 'pg';

export interface AlertMessage {
  readonly incidentKey: string;
  readonly title: string;
  readonly body: string;
  readonly recovery: boolean;
}

export interface AlertTransport {
  readonly name: string;
  send(message: AlertMessage): Promise<void>;
}

export function createTelegramTransport(
  config: { readonly botToken: string; readonly chatId: string },
  fetchImplementation: typeof fetch = fetch,
): AlertTransport {
  return {
    name: 'telegram',
    async send(message): Promise<void> {
      const response = await fetchImplementation(
        `https://api.telegram.org/bot${encodeURIComponent(config.botToken)}/sendMessage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: config.chatId, text: `${message.title}\n\n${message.body}` }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) throw new Error(`Telegram returned HTTP ${response.status}`);
    },
  };
}

export function createSmtpTransport(config: {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user?: string;
  readonly password?: string;
  readonly from: string;
  readonly to: string;
}): AlertTransport {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.user === undefined || config.password === undefined ? {} : {
      auth: { user: config.user, pass: config.password },
    }),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return {
    name: 'smtp',
    async send(message): Promise<void> {
      await transporter.sendMail({
        from: config.from,
        to: config.to,
        subject: `[Atodotren] ${message.title}`,
        text: message.body,
      });
    },
  };
}

export async function sendOperationalAlert(
  transports: readonly AlertTransport[],
  message: AlertMessage,
): Promise<void> {
  const results = await Promise.allSettled(transports.map(async (transport) => transport.send(message)));
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) throw new AggregateError(
    failures.map((failure) => failure.reason as unknown), 'Alert delivery failed',
  );
}

interface IncidentRow {
  readonly occurrence_count: number;
  readonly is_open: boolean;
  readonly last_notified_at: Date | null;
}

export async function observeIncident(options: {
  readonly pool: Pool;
  readonly transports: readonly AlertTransport[];
  readonly incidentKey: string;
  readonly active: boolean;
  readonly title: string;
  readonly body: string;
  readonly threshold: number;
  readonly details?: Readonly<Record<string, unknown>>;
}): Promise<'none' | 'opened' | 'notified' | 'recovered'> {
  const existing = await options.pool.query<IncidentRow>(`
    SELECT occurrence_count, is_open, last_notified_at
    FROM operations.notification_incident WHERE incident_key = $1
  `, [options.incidentKey]);
  const row = existing.rows[0];
  if (!options.active) {
    if (row?.is_open !== true) return 'none';
    if (row.last_notified_at !== null) {
      await sendOperationalAlert(options.transports, {
        incidentKey: options.incidentKey,
        title: `${options.title} recovered`,
        body: options.body,
        recovery: true,
      });
    }
    await options.pool.query(`
      UPDATE operations.notification_incident SET
        is_open = false, recovered_at = clock_timestamp(), last_observed_at = clock_timestamp()
      WHERE incident_key = $1
    `, [options.incidentKey]);
    return 'recovered';
  }

  const updated = await options.pool.query<IncidentRow>(`
    INSERT INTO operations.notification_incident (
      incident_key, opened_at, last_observed_at, occurrence_count, is_open, details
    ) VALUES ($1, clock_timestamp(), clock_timestamp(), 1, true, $2::jsonb)
    ON CONFLICT (incident_key) DO UPDATE SET
      opened_at = CASE WHEN operations.notification_incident.is_open
        THEN operations.notification_incident.opened_at ELSE clock_timestamp() END,
      last_observed_at = clock_timestamp(),
      occurrence_count = CASE WHEN operations.notification_incident.is_open
        THEN operations.notification_incident.occurrence_count + 1 ELSE 1 END,
      is_open = true,
      recovered_at = NULL,
      last_notified_at = CASE WHEN operations.notification_incident.is_open
        THEN operations.notification_incident.last_notified_at ELSE NULL END,
      details = EXCLUDED.details
    RETURNING occurrence_count, is_open, last_notified_at
  `, [options.incidentKey, JSON.stringify(options.details ?? {})]);
  const current = updated.rows[0];
  if (current === undefined) return 'none';
  if (current.occurrence_count < options.threshold || current.last_notified_at !== null) return 'opened';
  await sendOperationalAlert(options.transports, {
    incidentKey: options.incidentKey, title: options.title, body: options.body, recovery: false,
  });
  await options.pool.query(`
    UPDATE operations.notification_incident SET last_notified_at = clock_timestamp()
    WHERE incident_key = $1
  `, [options.incidentKey]);
  return 'notified';
}

export async function emitHeartbeat(url: string, fetchImplementation: typeof fetch = fetch): Promise<void> {
  const response = await fetchImplementation(url, { method: 'GET', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Heartbeat returned HTTP ${response.status}`);
}
