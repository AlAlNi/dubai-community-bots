import { createHash } from 'node:crypto';
import { TEST_BOT } from './telegram-setup.js';

const hash = value => createHash('sha256').update(value).digest('hex');
export function approvedDraft(report, id, confirmed, now = Date.now()) {
  if (confirmed !== true) throw new Error('Нужно подтвердить ручную проверку выбранной карточки');
  if (report?.version !== 1 || report.environment !== 'test' || report.demo !== false || !Array.isArray(report.drafts)) {
    throw new Error('Нужен реальный отчёт поиска из test');
  }
  const matches = report.drafts.filter(d => d.material?.id === id);
  if (matches.length !== 1) throw new Error('Не найден единственный черновик с указанным ID');
  const d = matches[0], v = d.style?.verdict, m = d.material;
  if (d.demo !== false || d.role !== 'housing' || m.role !== 'housing' || d.status !== 'needs_review'
    || !['checked', 'accepted'].includes(d.style?.status)
    || !['source_consistent', 'supported', 'complete', 'non_redundant'].every(k => v?.[k] === true)
    || !Array.isArray(v?.issues) || v.issues.length) throw new Error('Черновик не прошёл проверку качества');
  const checked = Date.parse(m.checked_at), expires = Date.parse(m.expires_at);
  if (!Number.isFinite(checked) || !Number.isFinite(expires) || checked > now || expires <= now
    || now - checked >= 3600000) throw new Error('Карточка устарела; нужен новый поиск жилья');
  if (typeof d.text !== 'string' || !d.text.trim() || d.text.length > 4000
    || typeof m.discovery_key !== 'string' || !m.discovery_key) throw new Error('Некорректная карточка');
  return d;
}

export function githubJournal({ token, repository, fetchImpl = fetch }) {
  if (!token || repository !== 'AlAlNi/dubai-community-bots') throw new Error('Не настроен журнал тестового репозитория');
  async function write(key, record, sha) {
    let response, data;
    try {
      response = await fetchImpl(`https://api.github.com/repos/${repository}/contents/.delivery/test/${key}.json`, {
        method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
        body: JSON.stringify({ branch: 'develop', message: `delivery: ${record.status} ${key.slice(0, 12)}`,
          content: Buffer.from(JSON.stringify(record, null, 2) + '\n').toString('base64'), ...(sha ? { sha } : {}) }),
      });
      data = await response.json();
    } catch { throw new Error('Журнал недоступен; автоматический повтор отправки запрещён'); }
    if (!response.ok || typeof data?.content?.sha !== 'string') {
      throw new Error('Не удалось записать журнал: карточка уже зарезервирована либо нет доступа к записи. Проверьте .delivery/test в develop');
    }
    return data.content.sha;
  }
  return { reserve: (key, record) => write(key, record), finish: write };
}

export async function sendHousing({ report, draftId, confirmed, token, chatId, journal,
  fetchImpl = fetch, now = () => Date.now() }) {
  const draft = approvedDraft(report, draftId, confirmed, now());
  if (typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]+$/.test(token)
    || typeof chatId !== 'string' || !/^-[1-9]\d*$/.test(chatId) || !Number.isSafeInteger(Number(chatId))) {
    throw new Error('Проверьте TEST_TELEGRAM_HOUSING_BOT_TOKEN и TEST_TELEGRAM_CHAT_ID');
  }
  async function call(method, body = {}) {
    let response, data;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      data = await response.json();
    } catch { throw new Error('Ответ Telegram не получен; проверьте группу. Автоматического повтора нет'); }
    if (!response.ok || data?.ok !== true) throw new Error('Telegram отклонил запрос; проверьте доступ бота. Автоматического повтора нет');
    return data.result;
  }
  const bot = await call('getMe');
  if (bot?.is_bot !== true || bot.username?.toLowerCase() !== TEST_BOT) throw new Error('Токен принадлежит другому боту');
  const chat = await call('getChat', { chat_id: chatId });
  if (String(chat?.id) !== chatId || !['group', 'supergroup'].includes(chat.type)
    || chat.username || chat.active_usernames?.length || chat.is_forum) throw new Error('Нужна закрытая тестовая группа без тем');
  const key = hash(`${TEST_BOT}\n${chatId}\n${draft.material.discovery_key}`);
  const record = { version: 1, status: 'reserved', reserved_at: new Date(now()).toISOString(),
    text_sha256: hash(draft.text) };
  // Atomic file creation without a SHA fails if any earlier attempt reserved this key.
  // This happens BEFORE sendMessage, so cancellation or an ambiguous reply cannot cause a retry.
  const sha = await journal.reserve(key, record);
  approvedDraft(report, draftId, confirmed, now());
  const sent = await call('sendMessage', { chat_id: chatId, text: draft.text,
    link_preview_options: { is_disabled: true }, disable_notification: true });
  if (!Number.isSafeInteger(sent?.message_id) || String(sent.chat?.id) !== chatId) {
    throw new Error('Результат отправки не подтверждён; проверьте группу. Резервирование сохранено');
  }
  try {
    await journal.finish(key, { ...record, status: 'sent', sent_at: new Date(now()).toISOString() }, sha);
  } catch { throw new Error('Telegram подтвердил отправку, но запись результата не удалась. Сообщение не повторяйте; резервирование сохранено'); }
  return { status: 'sent' };
}
