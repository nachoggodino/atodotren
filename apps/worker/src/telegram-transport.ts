export interface TelegramUser {
  readonly id: number;
}

export interface TelegramChat {
  readonly id: number;
  readonly type: string;
}

export interface TelegramMessage {
  readonly message_id: number;
  readonly from?: TelegramUser;
  readonly chat: TelegramChat;
  readonly text?: string;
}

export interface TelegramCallbackQuery {
  readonly id: string;
  readonly from: TelegramUser;
  readonly message?: TelegramMessage;
  readonly data?: string;
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
  readonly callback_query?: TelegramCallbackQuery;
}

interface ApiEnvelope<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly error_code?: number;
  readonly parameters?: { readonly retry_after?: number };
}

export interface InlineButton {
  readonly text: string;
  readonly callback_data: string;
}

export type TelegramParseMode = 'HTML';
export const TELEGRAM_TEXT_LIMIT = 4_000;

export class TelegramApiError extends Error {
  public readonly status: number;
  public readonly errorCode: number | undefined;
  public readonly retryAfterSeconds: number | undefined;

  public constructor(status: number, errorCode?: number, retryAfterSeconds?: number) {
    super(`Telegram Bot API request failed with HTTP ${status}${errorCode === undefined ? '' : ` (code ${errorCode})`}`);
    this.name = 'TelegramApiError';
    this.status = status;
    this.errorCode = errorCode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class TelegramWebhookConflictError extends Error {
  public constructor() {
    super('Telegram webhook is configured; getUpdates long polling cannot start until the webhook is removed explicitly');
    this.name = 'TelegramWebhookConflictError';
  }
}

export class TelegramBotApi {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  public constructor(options: { readonly token: string; readonly baseUrl?: string; readonly fetchImplementation?: typeof fetch }) {
    this.#token = options.token;
    this.#baseUrl = (options.baseUrl ?? 'https://api.telegram.org').replace(/\/$/u, '');
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async #call<T>(method: string, body: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(60_000);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const response = await this.#fetch(`${this.#baseUrl}/bot${encodeURIComponent(this.#token)}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: combined,
    });
    let payload: ApiEnvelope<T> | undefined;
    try {
      payload = await response.json() as ApiEnvelope<T>;
    } catch {
      payload = undefined;
    }
    if (!response.ok || payload?.ok !== true || payload.result === undefined) {
      const retryAfter = payload?.parameters?.retry_after;
      throw new TelegramApiError(
        response.status,
        payload?.error_code,
        Number.isSafeInteger(retryAfter) && (retryAfter ?? 0) > 0 ? retryAfter : undefined,
      );
    }
    return payload.result;
  }

  public async assertLongPollingAvailable(signal?: AbortSignal): Promise<void> {
    const info = await this.#call<{ readonly url: string }>('getWebhookInfo', {}, signal);
    if (info.url !== '') throw new TelegramWebhookConflictError();
  }

  public async registerCommands(chatId: string, signal?: AbortSignal): Promise<void> {
    await this.#call<boolean>('deleteMyCommands', { scope: { type: 'default' } }, signal);
    await this.#call<boolean>('setMyCommands', {
      scope: { type: 'chat', chat_id: chatId },
      commands: [
        { command: 'status', description: 'Current ingestion and incident status' },
        { command: 'daily', description: 'Daily functional and technical summary' },
        { command: 'line', description: 'One line summary' },
        { command: 'station', description: 'One station summary' },
        { command: 'trains', description: 'Active trains on a line' },
        { command: 'train', description: 'Current or recent train status' },
        { command: 'incidents', description: 'Open and recent incident episodes' },
        { command: 'resources', description: 'Resource and storage status' },
        { command: 'pilot', description: 'Evidence pilot progress' },
        { command: 'help', description: 'Command syntax and examples' },
      ],
    }, signal);
  }

  public async getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal): Promise<readonly TelegramUpdate[]> {
    return this.#call<readonly TelegramUpdate[]>('getUpdates', {
      offset,
      limit: 50,
      timeout: timeoutSeconds,
      allowed_updates: ['message', 'callback_query'],
    }, signal);
  }

  public async sendMessage(
    chatId: string,
    text: string,
    options: { readonly buttons?: readonly (readonly InlineButton[])[]; readonly disableNotification?: boolean; readonly parseMode?: TelegramParseMode } = {},
    signal?: AbortSignal,
  ): Promise<{ readonly message_id: number }> {
    if (text.length > TELEGRAM_TEXT_LIMIT) throw new RangeError(`Telegram text response exceeds the bounded ${TELEGRAM_TEXT_LIMIT}-character service limit`);
    return this.#call<{ readonly message_id: number }>('sendMessage', {
      chat_id: chatId,
      text,
      disable_notification: options.disableNotification ?? false,
      ...(options.parseMode === undefined ? {} : { parse_mode: options.parseMode }),
      ...(options.buttons === undefined ? {} : { reply_markup: { inline_keyboard: options.buttons } }),
    }, signal);
  }

  public async answerCallbackQuery(callbackQueryId: string, signal?: AbortSignal): Promise<void> {
    await this.#call<boolean>('answerCallbackQuery', { callback_query_id: callbackQueryId }, signal);
  }
}
