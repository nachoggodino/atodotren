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

export class RetryingAlertDelivery {
  readonly #transports: readonly AlertTransport[];
  readonly #delivered = new Map<string, Set<number>>();

  public constructor(transports: readonly AlertTransport[]) {
    this.#transports = transports;
  }

  public get transportCount(): number {
    return this.#transports.length;
  }

  public deliveredIndexes(episodeId: string, recovery: boolean): ReadonlySet<number> {
    return new Set(this.#delivered.get(`${episodeId}:${recovery ? 'recovery' : 'active'}`) ?? []);
  }

  public clearEpisode(episodeId: string): void {
    this.#delivered.delete(`${episodeId}:active`);
    this.#delivered.delete(`${episodeId}:recovery`);
  }

  public async send(
    message: AlertMessage,
    episodeId = message.incidentKey,
    eligibleIndexes?: ReadonlySet<number>,
  ): Promise<void> {
    const deliveryKey = `${episodeId}:${message.recovery ? 'recovery' : 'active'}`;
    const delivered = this.#delivered.get(deliveryKey) ?? new Set<number>();
    const pending = this.#transports
      .map((transport, index) => ({ transport, index }))
      .filter(({ index }) => (eligibleIndexes?.has(index) ?? true) && !delivered.has(index));
    const results = await Promise.allSettled(pending.map(async ({ transport }) => transport.send(message)));
    const failures: unknown[] = [];
    results.forEach((result, resultIndex) => {
      const item = pending[resultIndex];
      if (item === undefined) return;
      if (result.status === 'fulfilled') delivered.add(item.index);
      else failures.push(new Error(`${item.transport.name} delivery failed`, { cause: result.reason as unknown }));
    });
    if (failures.length > 0) {
      this.#delivered.set(deliveryKey, delivered);
      throw new AggregateError(failures, 'Alert delivery failed');
    }
    this.#delivered.set(deliveryKey, delivered);
  }
}

export interface NotificationChannelResult {
  readonly channel: 'telegram' | 'smtp' | 'heartbeat';
  readonly status: 'delivered' | 'failed' | 'skipped';
  readonly configured: boolean;
}

export async function testNotificationChannels(options: {
  readonly transports: readonly AlertTransport[];
  readonly heartbeatUrl?: string;
  readonly fetchImplementation?: typeof fetch;
}): Promise<readonly NotificationChannelResult[]> {
  const message: AlertMessage = {
    incidentKey: 'manual.notification-test',
    title: '[TEST] Atodotren operational notification',
    body: 'This is an explicit delivery test. It is not a real operational incident.',
    recovery: false,
  };
  const transportByName = new Map(options.transports.map((transport) => [transport.name, transport]));
  const results: NotificationChannelResult[] = [];
  for (const channel of ['telegram', 'smtp'] as const) {
    const transport = transportByName.get(channel);
    if (transport === undefined) {
      results.push({ channel, configured: false, status: 'skipped' });
      continue;
    }
    try {
      await transport.send(message);
      results.push({ channel, configured: true, status: 'delivered' });
    } catch {
      results.push({ channel, configured: true, status: 'failed' });
    }
  }
  if (options.heartbeatUrl === undefined) {
    results.push({ channel: 'heartbeat', configured: false, status: 'skipped' });
  } else {
    try {
      await emitHeartbeat(options.heartbeatUrl, options.fetchImplementation);
      results.push({ channel: 'heartbeat', configured: true, status: 'delivered' });
    } catch {
      results.push({ channel: 'heartbeat', configured: true, status: 'failed' });
    }
  }
  return results;
}

interface IncidentRow {
  readonly opened_at: Date;
  readonly occurrence_count: number;
  readonly is_open: boolean;
  readonly last_notified_at: Date | null;
}

export interface IncidentRecord {
  readonly openedAt: Date;
  readonly occurrenceCount: number;
  readonly isOpen: boolean;
  readonly lastNotifiedAt: Date | null;
}

export interface IncidentStore {
  read(incidentKey: string): Promise<IncidentRecord | undefined>;
  saveOpen(options: {
    readonly incidentKey: string;
    readonly occurrenceCount: number;
    readonly details: Readonly<Record<string, unknown>>;
  }): Promise<boolean>;
  markNotified(incidentKey: string): Promise<boolean>;
  close(incidentKey: string): Promise<boolean>;
}

export class PostgresIncidentStore implements IncidentStore {
  readonly #pool: Pool;

  public constructor(pool: Pool) {
    this.#pool = pool;
  }

  public async read(incidentKey: string): Promise<IncidentRecord | undefined> {
    const result = await this.#pool.query<IncidentRow>(`
      SELECT opened_at, occurrence_count, is_open, last_notified_at
      FROM operations.notification_incident WHERE incident_key = $1
    `, [incidentKey]);
    const row = result.rows[0];
    return row === undefined ? undefined : {
      openedAt: row.opened_at,
      occurrenceCount: row.occurrence_count,
      isOpen: row.is_open,
      lastNotifiedAt: row.last_notified_at,
    };
  }

  public async saveOpen(options: {
    readonly incidentKey: string;
    readonly occurrenceCount: number;
    readonly details: Readonly<Record<string, unknown>>;
  }): Promise<boolean> {
    const result = await this.#pool.query(`
      INSERT INTO operations.notification_incident (
        incident_key, opened_at, last_observed_at, last_notified_at,
        occurrence_count, is_open, recovered_at, details
      ) VALUES ($1, clock_timestamp(), clock_timestamp(), NULL, $2, true, NULL, $3::jsonb)
      ON CONFLICT (incident_key) DO UPDATE SET
        opened_at = CASE WHEN operations.notification_incident.is_open
          THEN operations.notification_incident.opened_at ELSE clock_timestamp() END,
        last_observed_at = clock_timestamp(),
        last_notified_at = CASE WHEN operations.notification_incident.is_open
          THEN operations.notification_incident.last_notified_at ELSE NULL END,
        occurrence_count = $2,
        is_open = true,
        recovered_at = NULL,
        details = $3::jsonb
    `, [options.incidentKey, options.occurrenceCount, JSON.stringify(options.details)]);
    return result.rowCount === 1;
  }

  public async markNotified(incidentKey: string): Promise<boolean> {
    const result = await this.#pool.query(`
      UPDATE operations.notification_incident SET
        last_notified_at = clock_timestamp(), last_observed_at = clock_timestamp()
      WHERE incident_key = $1 AND is_open
    `, [incidentKey]);
    return result.rowCount === 1;
  }

  public async close(incidentKey: string): Promise<boolean> {
    const result = await this.#pool.query(`
      UPDATE operations.notification_incident SET
        is_open = false, recovered_at = clock_timestamp(), last_observed_at = clock_timestamp()
      WHERE incident_key = $1 AND is_open
    `, [incidentKey]);
    return result.rowCount === 1;
  }
}

export type IncidentObservationResult = 'none' | 'opened' | 'notified' | 'recovered';
export type IncidentEventHandler = (
  event: 'notification.state_read_failed' | 'notification.state_write_failed' | 'notification.delivery_failed',
  fields: Readonly<Record<string, unknown>>,
) => void;

interface LocalIncidentState {
  count: number;
  notified: boolean;
  open: boolean;
  recoveryCount: number;
  episodeId: string;
}

function safeErrorClassification(error: unknown): Readonly<Record<string, unknown>> {
  const errorName = error instanceof Error ? error.name : 'NonError';
  const rawCode = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
  const errorCode = typeof rawCode === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(rawCode)
    ? rawCode
    : undefined;
  return { errorName, ...(errorCode === undefined ? {} : { errorCode }) };
}

export class IncidentTracker {
  readonly #state = new Map<string, LocalIncidentState>();
  readonly #store: IncidentStore;
  readonly #delivery: RetryingAlertDelivery;
  readonly #onEvent: IncidentEventHandler | undefined;
  readonly #now: () => Date;
  #episodeSequence = 0;

  public constructor(options: {
    readonly store: IncidentStore;
    readonly transports: readonly AlertTransport[];
    readonly onEvent?: IncidentEventHandler;
    readonly now?: () => Date;
  }) {
    this.#store = options.store;
    this.#delivery = new RetryingAlertDelivery(options.transports);
    this.#onEvent = options.onEvent;
    this.#now = options.now ?? (() => new Date());
  }

  async #load(incidentKey: string): Promise<LocalIncidentState> {
    const cached = this.#state.get(incidentKey);
    if (cached !== undefined) return cached;
    try {
      const stored = await this.#store.read(incidentKey);
      const state: LocalIncidentState = stored?.isOpen === true ? {
        count: stored.occurrenceCount,
        notified: stored.lastNotifiedAt !== null,
        open: true,
        recoveryCount: 0,
        episodeId: `${incidentKey}:${stored.openedAt.toISOString()}`,
      } : {
        count: 0, notified: false, open: false, recoveryCount: 0,
        episodeId: `${incidentKey}:closed`,
      };
      this.#state.set(incidentKey, state);
      return state;
    } catch (error) {
      this.#onEvent?.('notification.state_read_failed', {
        incidentKey, operation: 'read', ...safeErrorClassification(error),
      });
      const state: LocalIncidentState = {
        count: 0, notified: false, open: false, recoveryCount: 0,
        episodeId: `${incidentKey}:unavailable`,
      };
      this.#state.set(incidentKey, state);
      return state;
    }
  }

  async #write(
    incidentKey: string,
    operation: 'save_open' | 'mark_notified' | 'close',
    action: () => Promise<boolean>,
  ): Promise<boolean> {
    try {
      const updated = await action();
      if (updated) return true;
      this.#onEvent?.('notification.state_write_failed', {
        incidentKey, operation, errorName: 'StateNotUpdated',
      });
    } catch (error) {
      this.#onEvent?.('notification.state_write_failed', {
        incidentKey, operation, ...safeErrorClassification(error),
      });
    }
    return false;
  }

  public async observe(options: {
    readonly incidentKey: string;
    readonly active: boolean;
    readonly recoveryObserved?: boolean;
    readonly recoveryThreshold?: number;
    readonly title: string;
    readonly body: string;
    readonly threshold: number;
    readonly details?: Readonly<Record<string, unknown>>;
  }): Promise<IncidentObservationResult> {
    const state = await this.#load(options.incidentKey);
    const details = options.details ?? { title: options.title, body: options.body };
    if (options.active) {
      state.recoveryCount = 0;
      if (!state.open) {
        state.count = 1;
        state.notified = false;
        state.open = true;
        state.episodeId = `${options.incidentKey}:${this.#now().toISOString()}:${this.#episodeSequence++}`;
      } else {
        state.count += 1;
      }
      const saved = await this.#write(options.incidentKey, 'save_open', () => this.#store.saveOpen({
        incidentKey: options.incidentKey, occurrenceCount: state.count, details,
      }));
      if (!saved || state.count < options.threshold || state.notified || this.#delivery.transportCount === 0) {
        return 'opened';
      }
      try {
        await this.#delivery.send({
          incidentKey: options.incidentKey, title: options.title, body: options.body, recovery: false,
        }, state.episodeId);
      } catch (error) {
        this.#onEvent?.('notification.delivery_failed', {
          incidentKey: options.incidentKey, operation: 'deliver_active', ...safeErrorClassification(error),
        });
        return 'opened';
      }
      const marked = await this.#write(
        options.incidentKey,
        'mark_notified',
        () => this.#store.markNotified(options.incidentKey),
      );
      if (!marked) return 'opened';
      state.notified = true;
      return 'notified';
    }

    if (!state.open) return 'none';
    const deliveredActive = this.#delivery.deliveredIndexes(state.episodeId, false);
    if (!state.notified && deliveredActive.size === this.#delivery.transportCount && deliveredActive.size > 0) {
      const marked = await this.#write(
        options.incidentKey,
        'mark_notified',
        () => this.#store.markNotified(options.incidentKey),
      );
      if (!marked) return 'opened';
      state.notified = true;
    }
    if (options.recoveryObserved === false) {
      state.recoveryCount = 0;
      if (!state.notified && this.#delivery.deliveredIndexes(state.episodeId, false).size === 0) {
        const closed = await this.#write(
          options.incidentKey,
          'close',
          () => this.#store.close(options.incidentKey),
        );
        if (!closed) return 'opened';
        this.#finalizeClosed(state);
        return 'recovered';
      }
      return 'opened';
    }
    state.recoveryCount += 1;
    if (state.recoveryCount < (options.recoveryThreshold ?? 1)) return 'opened';

    const activeDelivered = state.notified
      ? new Set(Array.from({ length: this.#delivery.transportCount }, (_, index) => index))
      : deliveredActive;
    if (activeDelivered.size > 0) {
      try {
        await this.#delivery.send({
          incidentKey: options.incidentKey,
          title: `${options.title} recovered`,
          body: options.body,
          recovery: true,
        }, state.episodeId, activeDelivered);
      } catch (error) {
        this.#onEvent?.('notification.delivery_failed', {
          incidentKey: options.incidentKey, operation: 'deliver_recovery', ...safeErrorClassification(error),
        });
        return 'opened';
      }
    }
    const closed = await this.#write(
      options.incidentKey,
      'close',
      () => this.#store.close(options.incidentKey),
    );
    if (!closed) return 'opened';
    this.#finalizeClosed(state);
    return 'recovered';
  }

  #finalizeClosed(state: LocalIncidentState): void {
    state.open = false;
    state.notified = false;
    state.count = 0;
    state.recoveryCount = 0;
    this.#delivery.clearEpisode(state.episodeId);
  }
}

export async function emitHeartbeat(url: string, fetchImplementation: typeof fetch = fetch): Promise<void> {
  const response = await fetchImplementation(url, { method: 'GET', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Heartbeat returned HTTP ${response.status}`);
}
