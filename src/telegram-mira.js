import { TEST_BOT } from './telegram-setup.js';
import { sendTestText } from './telegram-send.js';

const question = 'Мира, какая погода в Дубае сегодня? Ответь коротко и добавь ссылку на источник. Если свежих данных нет, так и скажи.';

// Only acknowledge the actual reply; do not turn unverified weather into advice.
export function closingReply(text) {
  if (/(нет доступа|не могу (проверить|посмотреть|узнать)|(?:свежих|актуальных) данных.{0,30}нет|нет (?:свежих|актуальных) данных)/iu.test(text)) {
    return 'Понял, Мира, спасибо! Тогда с прогулкой пока не определились 🙂';
  }
  if (text.includes('?')) return 'Спасибо, Мира! Пока просто прикидываем, получится ли сегодня погулять 🙂';
  return 'Спасибо, Мира! Перед прогулкой стоит ещё свериться с прогнозом 🙂';
}

export function findMiraReply(updates, chatId, botId, now) {
  if (!Array.isArray(updates) || updates.length >= 100) throw new Error('Очередь обновлений неполная; отправка остановлена');
  const matches = updates.map(u => u.message).filter(m => {
    const parent = m?.reply_to_message;
    return String(m?.chat?.id) === chatId && m?.from?.username?.toLowerCase() === 'mira'
      && !m.forward_origin && !m.sender_chat && !parent?.forward_origin
      && Number.isSafeInteger(m.message_id) && m.message_id > 0
      && Number.isInteger(m.date) && m.date * 1000 >= now - 24 * 3600000 && m.date * 1000 <= now + 60000
      && typeof m.text === 'string' && m.text.trim() && m.text.length <= 4096
      && parent?.from?.id === botId && parent.from.is_bot === true
      && parent.text === question && String(parent.chat?.id) === chatId
      && Number.isSafeInteger(parent.message_id) && parent.message_id < m.message_id;
  });
  const unique = [...new Map(matches.map(m => [m.message_id, m])).values()];
  if (unique.length > 1) throw new Error('Найдено несколько ответов Миры; автоматическое продолжение остановлено');
  return unique[0];
}

export async function replyToMira({ token, chatId, journal, fetchImpl = fetch, now = () => Date.now() }) {
  if (typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]+$/.test(token)
    || typeof chatId !== 'string' || !/^-[1-9]\d*$/.test(chatId) || !Number.isSafeInteger(Number(chatId))) {
    throw new Error('Проверьте тестовые секреты Telegram');
  }
  async function call(method, body = {}) {
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok || data?.ok !== true) throw new Error();
      return data.result;
    } catch { throw new Error('Не удалось прочитать Telegram; проверьте доступ и отсутствие другого получателя обновлений'); }
  }
  const bot = await call('getMe');
  if (bot?.is_bot !== true || bot.username?.toLowerCase() !== TEST_BOT || !Number.isSafeInteger(bot.id)) {
    throw new Error('Токен принадлежит другому боту');
  }
  const webhook = await call('getWebhookInfo');
  if (!webhook || webhook.url !== '') throw new Error('У бота установлен webhook либо его состояние неизвестно; ничего не изменено');
  // No offset: do not acknowledge or discard updates belonging to other features.
  const updates = await call('getUpdates', { limit: 100, timeout: 0, allowed_updates: ['message'] });
  const reply = findMiraReply(updates, chatId, bot.id, now());
  if (!reply) return { status: 'waiting' };
  // One closing turn for this entire test, regardless of reply ID or workflow rerun.
  return sendTestText({ token, chatId, journal, fetchImpl, now,
    text: closingReply(reply.text), identity: 'mira-weather-v1-closing', replyToMessageId: reply.message_id });
}
