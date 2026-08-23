import { createServer } from 'node:http';

const port = Number(process.env.FAKE_TELEGRAM_PORT ?? '4020');
const allowedUserId = Number(process.env.FAKE_TELEGRAM_USER_ID ?? '10101');
const privateChatId = Number(process.env.FAKE_TELEGRAM_CHAT_ID ?? '10101');
const webhookUrl = process.env.FAKE_TELEGRAM_WEBHOOK_URL ?? '';
const initialText = process.env.FAKE_TELEGRAM_INITIAL_COMMAND ?? '/status';
let nextMessageId = 500;
const updates = [{
  update_id: 100,
  message: {
    message_id: 10,
    from: { id: allowedUserId, is_bot: false, first_name: 'CI' },
    chat: { id: privateChatId, type: 'private', first_name: 'CI' },
    date: 1_700_000_000,
    text: initialText,
  },
}];
const state = {
  getUpdatesCalls: 0,
  sentMessages: [],
  setCommands: [],
  deleteCommands: 0,
  callbackAnswers: 0,
};

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  if (request.url === '/health') return json(response, 200, { ok: true });
  if (request.url === '/state') return json(response, 200, state);
  if (request.method !== 'POST' || request.url === undefined) return json(response, 404, { ok: false });
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let body = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return json(response, 400, { ok: false }); }
  const method = request.url.split('/').at(-1);
  if (method === 'getWebhookInfo') return json(response, 200, { ok: true, result: { url: webhookUrl, has_custom_certificate: false, pending_update_count: 0 } });
  if (method === 'deleteMyCommands') { state.deleteCommands += 1; return json(response, 200, { ok: true, result: true }); }
  if (method === 'setMyCommands') { state.setCommands.push(body); return json(response, 200, { ok: true, result: true }); }
  if (method === 'getUpdates') {
    state.getUpdatesCalls += 1;
    const offset = Number(body.offset ?? 0);
    const result = updates.filter((update) => update.update_id >= offset);
    if (result.length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
    return json(response, 200, { ok: true, result });
  }
  if (method === 'sendMessage') {
    const message = { message_id: nextMessageId++, chat: { id: Number(body.chat_id), type: 'private' }, text: String(body.text ?? '') };
    state.sentMessages.push({ chat_id: body.chat_id, text: body.text, reply_markup: body.inline_keyboard ?? null, message_id: message.message_id });
    return json(response, 200, { ok: true, result: message });
  }
  if (method === 'answerCallbackQuery') { state.callbackAnswers += 1; return json(response, 200, { ok: true, result: true }); }
  return json(response, 404, { ok: false, description: `unsupported fake method ${method}` });
});

server.listen(port, '0.0.0.0');
const shutdown = () => server.close(() => process.exit(0));
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
