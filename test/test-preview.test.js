import test from 'node:test';
import assert from 'node:assert/strict';
import { testPreview } from '../src/telegram-preview.js';
const report = { version: 1, environment: 'test', demo: false, drafts: [], rejected: [] };
test('empty extraction diagnosis reaches Telegram without inflating rejected count', () => {
  const text = testPreview({ ...report, search_diagnostics: [{ reason: 'Извлечение вернуло пустой список.' }] }, 'housing');
  assert.match(text, /Извлечение вернуло пустой список/);
  assert.match(text, /отклонено при извлечении: 0/);
});
test('empty search sends the actual rejection reasons instead of silence', () => {
  const text = testPreview({ ...report, rejected: [{ reason: 'Цена не связана с цитатой' }] }, 'housing');
  assert.match(text, /Карточек нет/); assert.match(text, /Цена не связана/);
});
test('blocked preview is explicitly labelled and keeps the report blocked', () => {
  const r = { ...report, drafts: [{ role: 'events', status: 'blocked', original_text: 'Текст', text: null,
    style: { verdict: { issues: ['Повтор времени'] } } }] };
  const text = testPreview(r, 'events');
  assert.match(text, /НЕ ПРОШЛА ПРОВЕРКУ/); assert.match(text, /Повтор времени/); assert.match(text, /Текст/);
  assert.equal(r.drafts[0].status, 'blocked');
});
test('preview is bounded and production reports are refused', () => {
  const text = testPreview({ ...report, drafts: [{ role: 'housing', status: 'blocked', original_text: 'x'.repeat(10000),
    style: { verdict: { issues: ['z'.repeat(5000)] } } }] }, 'housing');
  assert.ok(text.length < 4000);
  assert.throws(() => testPreview({ ...report, environment: 'production' }, 'housing'));
});
