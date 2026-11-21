import { TEST_BOT } from './telegram-setup.js';
import { sendTestText } from './telegram-send.js';
import { telegramMessageText } from './telegram-message-text.js';

const question = 'Мира, какая погода в Дубае сегодня? Ответь коротко и добавь ссылку на источник. Если свежих данных нет, так и скажи.';

// Only acknowledge the actual reply; do not turn unverified weather into advice.
export function closingReply(text) {
  if (/(нет доступа|не могу (проверить|посмотреть|узнать)|(?:свежих|актуальных) данных.{0,30}нет|нет (?:свежих|актуальных) данных)/iu.test(text)) {
    return 'Понял, Мира, спасибо! Тогда с прогулкой пока не определились 🙂';
  }
  if (text.includes('?')) return 'Спасибо, Мира! Пока просто прикидываем, получится ли сегодня погулять 🙂';
  return 'Спасибо, Мира! Перед прогулкой стоит ещё свериться с прогнозом 🙂';
}

function replyChecks(m, chatId, botId, now) {
  const parent = m?.reply_to_message;
  return {
    target_chat: String(m?.chat?.id) === chatId,
    mira_sender: m?.from?.username?.toLowerCase() === 'mira',
    original_message: !!m && !m.forward_origin && !m.sender_chat && !parent?.forward_origin,
    valid_message_id: Number.isSafeInteger(m?.message_id) && m.message_id > 0,
    fresh_message: Number.isInteger(m?.date) && m.date * 1000 >= now - 24 * 3600000 && m.date * 1000 <= now + 60000,
    text_message: telegramMessageText(m) !== undefined,
    reply_to_housing: parent?.from?.id === botId && parent?.from?.is_bot === true,
    exact_weather_question: parent?.text === question,
    parent_same_chat: String(parent?.chat?.id) === chatId,
    valid_reply_order: Number.isSafeInteger(parent?.message_id) && parent.message_id < m?.message_id,
  };
}

export function diagnoseMiraUpdates(updates, chatId, botId, now) {
  if (!Array.isArray(updates)) return { invalid_updates: true };
  const counts = { updates: updates.length, queue_full: updates.length >= 100,
    ordinary_messages: 0, other_updates: 0, target_chat_messages: 0,
    mira_sender_messages: 0, via_mira_messages: 0, replies_to_housing: 0, matches: 0,
    rejected_checks_in_target_chat: {}, mira_content: {
      text_missing: 0, text_not_string: 0, text_empty: 0, text_too_long: 0,
      text_usable: 0, caption_present: 0, rich_message_present: 0,
      rich_blocks_array: 0, photo_present: 0, document_present: 0,
    } };
  for (const u of updates) {
    const m = u?.message;
    if (!m) { counts.other_updates++; continue; }
    counts.ordinary_messages++;
    const checks = replyChecks(m, chatId, botId, now);
    if (!checks.target_chat) continue;
    counts.target_chat_messages++;
    if (checks.mira_sender) {
      counts.mira_sender_messages++;
      const content = counts.mira_content;
      if (m.text === undefined || m.text === null) content.text_missing++;
      else if (typeof m.text !== 'string') content.text_not_string++;
      else if (!m.text.trim()) content.text_empty++;
      else if (m.text.length > 4096) content.text_too_long++;
      else content.text_usable++;
      if (typeof m.caption === 'string' && m.caption.trim()) content.caption_present++;
      if (m.rich_message && typeof m.rich_message === 'object') content.rich_message_present++;
      if (Array.isArray(m.rich_message?.blocks)) content.rich_blocks_array++;
      if (Array.isArray(m.photo)) content.photo_present++;
      if (m.document && typeof m.document === 'object') content.document_present++;
    }
    if (m.via_bot?.username?.toLowerCase() === 'mira') counts.via_mira_messages++;
    if (checks.reply_to_housing) counts.replies_to_housing++;
    if (Object.values(checks).every(Boolean)) counts.matches++;
    for (const [key, passed] of Object.entries(checks)) {
      if (!passed) counts.rejected_checks_in_target_chat[key] = (counts.rejected_checks_in_target_chat[key] ?? 0) + 1;
    }
  }
  return counts;
}

export function findMiraReply(updates, chatId, botId, now) {
  if (!Array.isArray(updates) || updates.length >= 100) throw new Error('Очередь обновлений неполная; отправка остановлена');
  const matches = updates.map(u => u.message).filter(m => Object.values(replyChecks(m, chatId, botId, now)).every(Boolean));
  const unique = [...new Map(matches.map(m => [m.message_id, m])).values()];
  if (unique.length > 1) throw new Error('Найдено несколько ответов Миры; автоматическое продолжение остановлено');
  return unique[0];
}

export async function replyToMira({ token, chatId, journal, fetchImpl = fetch, now = () => Date.now(),
  diagnosticOnly = false, onDiagnostic = () => {} }) {
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
  onDiagnostic({ stage: 'connection',
    can_read_all_group_messages: typeof bot.can_read_all_group_messages === 'boolean' ? bot.can_read_all_group_messages : null,
    webhook_active: typeof webhook?.url === 'string' ? !!webhook.url : null,
    pending_update_count: Number.isSafeInteger(webhook?.pending_update_count) ? webhook.pending_update_count : null });
  if (!webhook || webhook.url !== '') throw new Error('У бота установлен webhook либо его состояние неизвестно; ничего не изменено');
  // No offset: do not acknowledge or discard updates belonging to other features.
  const updates = await call('getUpdates', { limit: 100, timeout: 0, allowed_updates: ['message'] });
  onDiagnostic({ stage: 'updates', ...diagnoseMiraUpdates(updates, chatId, bot.id, now()) });
  if (diagnosticOnly) return { status: 'diagnostic' };
  const reply = findMiraReply(updates, chatId, bot.id, now());
  if (!reply) return { status: 'waiting' };
  // One closing turn for this entire test, regardless of reply ID or workflow rerun.
  return sendTestText({ token, chatId, journal, fetchImpl, now,
    text: closingReply(telegramMessageText(reply)), identity: 'mira-weather-v1-closing', replyToMessageId: reply.message_id });
}
