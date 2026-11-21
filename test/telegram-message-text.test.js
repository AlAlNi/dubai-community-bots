import test from 'node:test';
import assert from 'node:assert/strict';
import { telegramMessageText } from '../src/telegram-message-text.js';

test('reads visible rich paragraphs, nested formatting, links and lists', () => {
  assert.equal(telegramMessageText({ rich_message: { blocks: [
    { type: 'paragraph', text: ['Свежих данных ', { type: 'bold', text: 'сейчас нет' }] },
    { type: 'list', items: [{ label: '•', blocks: [{ type: 'paragraph', text:
      { type: 'url', text: [{ type: 'italic', text: 'Прогноз' }], url: 'https://example.com/PRIVATE' } }] }] },
    { type: 'paragraph', text: { type: 'custom_emoji', alternative_text: '☀️', custom_emoji_id: 'private' } },
  ] } }), 'Свежих данных сейчас нет\n- Прогноз\n\n☀️');
});

test('rejects empty, unsupported, malformed, excessive and recursive content without partial text', () => {
  const cyclic = { type: 'bold' }; cyclic.text = cyclic;
  for (const blocks of [[], [{ type: 'paragraph', text: ' ' }],
    [{ type: 'paragraph', text: 'valid' }, { type: 'photo', photo: [] }],
    [{ type: 'paragraph', text: cyclic }], [{ type: 'list', items: {} }],
    [{ type: 'paragraph', text: 'x'.repeat(16385) }],
    Array(2001).fill({ type: 'paragraph', text: '' })]) {
    assert.equal(telegramMessageText({ rich_message: { blocks } }), undefined);
  }
  assert.equal(telegramMessageText({ text: 'x'.repeat(4097) }), undefined);
  assert.equal(telegramMessageText({ text: 'Обычный ответ' }), 'Обычный ответ');
});
