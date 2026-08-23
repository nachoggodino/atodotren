import type { DeliveryRecord } from './telegram-state.js';
import { TelegramApiError } from './telegram-transport.js';

export const TELEGRAM_DELIVERY_MAX_ATTEMPTS = 8;

const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 300_000;
const PERMANENT_FAILURE_PREFIX = 'Permanent.';

export interface TelegramDeliveryFailure {
  readonly abandon: boolean;
  readonly delayMs: number;
  readonly failureClass: string;
}

export function telegramDeliveryRetryDelay(attempts: number): number {
  const exponent = Math.max(0, Math.min(6, attempts - 1));
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** exponent);
}

export function telegramDeliveryRetryWait(record: DeliveryRecord | null, now: Date): number | null {
  if (record === null || record.delivered || record.failureClass?.startsWith(PERMANENT_FAILURE_PREFIX) === true) {
    return null;
  }
  if (record.attempts >= TELEGRAM_DELIVERY_MAX_ATTEMPTS) return null;
  if (record.lastAttemptAt === null) return 0;
  return Math.max(0, telegramDeliveryRetryDelay(record.attempts) - (now.getTime() - record.lastAttemptAt.getTime()));
}

export function telegramDeliveryAbandoned(record: DeliveryRecord | null): boolean {
  return record !== null
    && !record.delivered
    && (record.attempts >= TELEGRAM_DELIVERY_MAX_ATTEMPTS
      || record.failureClass?.startsWith(PERMANENT_FAILURE_PREFIX) === true);
}

export function classifyTelegramDeliveryFailure(error: unknown, attempts: number): TelegramDeliveryFailure {
  const permanent = error instanceof RangeError
    || (error instanceof TelegramApiError
      && error.status >= 400
      && error.status < 500
      && ![408, 429].includes(error.status));
  const abandon = permanent || attempts >= TELEGRAM_DELIVERY_MAX_ATTEMPTS;
  const retryAfterMs = error instanceof TelegramApiError && error.retryAfterSeconds !== undefined
    ? error.retryAfterSeconds * 1_000
    : 0;
  const rawClass = error instanceof Error ? error.name : 'DeliveryError';
  const baseClass = /^[A-Za-z0-9_.-]{1,48}$/u.test(rawClass) ? rawClass : 'DeliveryError';
  return {
    abandon,
    delayMs: Math.min(MAX_DELAY_MS, Math.max(telegramDeliveryRetryDelay(attempts), retryAfterMs)),
    failureClass: `${abandon ? PERMANENT_FAILURE_PREFIX : ''}${baseClass}`,
  };
}
