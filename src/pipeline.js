import { createHash } from 'node:crypto';

const voices = {
  guide: ['Гид', 'Полезное место на заметку.'],
  events: ['Афиша', 'Есть идея, куда выбраться.'],
  transport: ['Транспорт', 'Если собираетесь в дорогу, вот что стоит учесть.'],
  everyday: ['Быт', 'Это может пригодиться в повседневных делах.'],
};
const text = value => typeof value === 'string' && value.trim().length > 0;
export function timestamp(value) {
  if (!text(value) || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      || !Number.isFinite(Date.parse(value))) throw new Error('Нужна дата ISO 8601 с часовым поясом');
  return Date.parse(value);
}
function canonicalUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Нужна публичная HTTPS-ссылка');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith('utm_') || ['fbclid', 'gclid'].includes(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.href;
}
function validate(item, now, maxAge) {
  if (!item || typeof item !== 'object') throw new Error('Материал должен быть объектом');
  for (const key of ['id', 'title', 'topic', 'source_name', 'source_url', 'checked_at', 'expires_at']) {
    if (!text(item[key])) throw new Error(`Отсутствует поле ${key}`);
  }
  if (!Object.hasOwn(voices, item.role)) throw new Error('Неизвестная роль');
  if (!Array.isArray(item.facts) || !item.facts.length || !item.facts.every(text)) throw new Error('Нужен непустой список фактов');
  canonicalUrl(item.source_url);
  const checked = timestamp(item.checked_at);
  const expires = timestamp(item.expires_at);
  if (checked > now) throw new Error('Проверка источника датирована будущим');
  if (expires <= now) throw new Error('Материал устарел');
  if (now - checked > maxAge * 3600000) throw new Error('Источник требует повторной проверки');
  if (item.role === 'events') {
    if (!text(item.location) || !text(item.conditions)) throw new Error('Для события нужны место и условия посещения');
    if (timestamp(item.event_at) <= now) throw new Error('Событие уже началось или прошло');
  }
}
function fingerprint(item) {
  return createHash('sha256').update(JSON.stringify({
    url: canonicalUrl(item.source_url), role: item.role, topic: item.topic,
    title: item.title.trim(), facts: item.facts.map(s => s.trim()),
    event_at: item.event_at ?? null, location: item.location ?? null, conditions: item.conditions ?? null,
  })).digest('hex');
}
function render(item, demo) {
  const [name, intro] = voices[item.role];
  const lines = [demo ? 'ДЕМО — вымышленные данные, не для публикации.' : null,
    `${name} · бот`, intro, item.title.trim(), item.facts.map(f => f.trim()).join('\n')];
  if (item.role === 'events') {
    const date = new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Asia/Dubai', dateStyle: 'long', timeStyle: 'short',
    }).format(new Date(item.event_at));
    lines.push(`Когда: ${date} (Дубай).`, `Где: ${item.location}`, `Условия: ${item.conditions}`);
  }
  lines.push(`Источник: ${item.source_name}\n${item.source_url}`, `Проверено: ${item.checked_at}`);
  return lines.filter(Boolean).join('\n\n');
}
export function prepare(items, config, previous = [], now = new Date().toISOString(), demo = false) {
  const clock = timestamp(now);
  if (!Array.isArray(items) || !Array.isArray(previous)) throw new Error('Ожидается массив материалов и черновиков');
  if (config.publication_mode !== 'draft_only') throw new Error('Прототип поддерживает только draft_only');
  if (!Number.isFinite(config.max_source_age_hours) || config.max_source_age_hours <= 0
      || !Array.isArray(config.manual_review_topics)) throw new Error('Некорректная конфигурация редактора');
  const drafts = previous.map(d => ({ ...d, status:
    timestamp(d.material.expires_at) <= clock || clock - timestamp(d.material.checked_at) > config.max_source_age_hours * 3600000
      || (d.material.role === 'events' && timestamp(d.material.event_at) <= clock) ? 'expired' : d.status }));
  const seen = new Set(drafts.filter(d => d.status !== 'expired').map(d => d.fingerprint));
  const rejected = [];
  const duplicates = [];
  let added = 0;
  for (const item of items) {
    try {
      validate(item, clock, config.max_source_age_hours);
      const key = fingerprint(item);
      if (seen.has(key)) { duplicates.push(item.id); continue; }
      const body = render(item, demo);
      if (body.length > 4000) throw new Error('Черновик длиннее 4000 символов: сократите исходный материал');
      drafts.push({ fingerprint: key, created_at: now, status: 'needs_review',
        review_reason: config.manual_review_topics.includes(item.topic) ? 'sensitive_topic' : 'prototype',
        demo, role: item.role, material: structuredClone(item), text: body });
      seen.add(key);
      added++;
    } catch (error) { rejected.push({ id: item?.id ?? null, reason: error.message }); }
  }
  return { version: 1, generated_at: now, demo, added, duplicates, rejected, drafts };
}
