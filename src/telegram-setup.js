export const TEST_BOT = 'dubai_housing_test_alalni_bot';

// Setup is deliberately read-only: no sendMessage, webhook changes or update acknowledgement.
export async function inspectTelegram({ token, fetchImpl = fetch, now = Date.now() }) {
  if (typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('Не задан корректный TEST_TELEGRAM_HOUSING_BOT_TOKEN');
  }
  async function call(method, body = {}) {
    let response, data;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      data = await response.json();
    } catch {
      // Fetch errors may contain the URL, which includes the credential.
      throw new Error('Telegram недоступен или вернул некорректный ответ; повторите настройку позже');
    }
    if (!response.ok || data?.ok !== true) throw new Error('Telegram отклонил запрос; проверьте токен и отсутствие другого процесса бота');
    return data.result;
  }
  const bot = await call('getMe');
  if (bot?.is_bot !== true || bot.username?.toLowerCase() !== TEST_BOT) {
    throw new Error('Токен принадлежит другому боту; нужен @' + TEST_BOT);
  }
  const webhook = await call('getWebhookInfo');
  if (!webhook || typeof webhook.url !== 'string') throw new Error('Некорректные сведения о webhook');
  if (webhook.url) throw new Error('У бота установлен webhook; настройка остановлена без его изменения');
  const updates = await call('getUpdates', { limit: 100, timeout: 0, allowed_updates: ['message'] });
  if (!Array.isArray(updates)) throw new Error('Некорректный список обновлений Telegram');
  const ids = new Set();
  for (const update of updates) {
    const m = update.message;
    if (!m || m.from?.is_bot !== false || m.forward_origin || m.sender_chat
      || !Number.isInteger(m.date) || m.date * 1000 < now - 24 * 3600000 || m.date * 1000 > now + 60000
      || m.text?.trim().toLowerCase() !== `/setup@${TEST_BOT}`
      || !['group', 'supergroup'].includes(m.chat?.type)
      || !Number.isSafeInteger(m.chat.id) || m.chat.id >= 0) continue;
    ids.add(m.chat.id);
  }
  if (updates.length === 100) throw new Error('Очередь обновлений заполнена; настройка остановлена, чтобы не выбрать группу из неполного списка');
  if (ids.size === 0) throw new Error('В тестовой группе отправьте /setup@' + TEST_BOT + ' и снова запустите workflow');
  if (ids.size !== 1) throw new Error('Команда найдена в нескольких группах; автоматический выбор остановлен');
  const chatId = [...ids][0];
  const chat = await call('getChat', { chat_id: chatId });
  if (chat?.id !== chatId || !['group', 'supergroup'].includes(chat.type)
    || chat.username || chat.active_usernames?.length || chat.is_forum) {
    throw new Error('Для теста нужна закрытая группа без публичного username и без тем');
  }
  return { username: TEST_BOT, chatId: String(chatId) };
}
