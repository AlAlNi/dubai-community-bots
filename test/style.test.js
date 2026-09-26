import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepare } from '../src/pipeline.js';
import { polishDraft } from '../src/style.js';

const settings = JSON.parse(await readFile(new URL('../config/style.json', import.meta.url)));
const editorial = JSON.parse(await readFile(new URL('../config/editorial.json', import.meta.url)));
const material = {
  id: 'style-fixture', role: 'events', topic: 'events', title: 'Учебная встреча',
  facts: ['Встреча посвящена настольным играм.', 'Начало в 18:00, окончание в 20:00.'],
  event_at: '2026-09-27T18:00:00+04:00', location: 'Учебный клуб', conditions: 'Вход бесплатный, нужна регистрация.',
  source_name: 'Учебный источник', source_url: 'https://example.com/event',
  checked_at: '2026-09-26T08:00:00+04:00', expires_at: '2026-09-27T08:00:00+04:00',
};
const draft = prepare([material], editorial, [], material.checked_at).drafts[0];
const edited = 'Можно собраться за настольными играми. Встреча продлится до 20:00.';
const deepseek = body => ({ id: 'editor-test', model: 'test', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ body }) } }], usage: { total_tokens: 10 } });
const verdict = (supported = true, complete = true, issues = []) => ({ id: 'check-test', model: 'test', status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ supported, complete, issues }) }] }] });
function mock(responses) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    const value = responses.shift();
    if (value instanceof Error) throw value;
    return { ok: true, status: 200, json: async () => value };
  } };
}
const options = { settings, deepseekKey: 'deepseek-test-only', openaiKey: 'openai-test-only' };

test('accepted style preserves immutable fields, original, status and routes credentials separately', async () => {
  const io = mock([deepseek(edited), verdict()]);
  const result = await polishDraft(draft, { ...options, fetchImpl: io.fetchImpl });
  assert.equal(result.style.status, 'accepted');
  assert.equal(result.original_text, draft.text);
  assert.equal(result.status, 'needs_review');
  assert.deepEqual(result.material, material);
  for (const value of [material.title, material.location, material.conditions, material.source_url, '18:00', '20:00']) assert.ok(result.text.includes(value));
  assert.equal(io.calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(io.calls[1].url, 'https://api.openai.com/v1/responses');
  assert.equal(io.calls[0].options.headers.Authorization, 'Bearer deepseek-test-only');
  assert.equal(io.calls[1].options.headers.Authorization, 'Bearer openai-test-only');
  assert.equal(io.calls[0].body.tools, undefined);
  assert.equal(io.calls[1].body.tools, undefined);
  assert.equal(io.calls[0].body.thinking.type, 'disabled');
});
test('new numbers and links reject the edit before verifier call', async () => {
  for (const body of ['Билет стоит 500 дирхамов.', 'Регистрация: https://evil.example', 'Пишите @invented']) {
    const io = mock([deepseek(body)]);
    const result = await polishDraft(draft, { ...options, fetchImpl: io.fetchImpl });
    assert.equal(result.text, draft.text);
    assert.equal(result.style.status, 'fallback');
    assert.equal(io.calls.length, 1);
  }
});
test('changed meaning, missing condition or uncertainty falls back even without new numbers', async () => {
  for (const check of [verdict(false, true, ['Выдуманная аудитория']), verdict(true, false, ['Потеряно окончание']), verdict(true, true, ['Есть сомнения'])]) {
    const io = mock([deepseek('Подходит всем детям, регистрация не нужна.'), check]);
    const result = await polishDraft(draft, { ...options, fetchImpl: io.fetchImpl });
    assert.equal(result.text, draft.text);
    assert.equal(result.style.reason, 'factual_check_failed');
  }
});
test('editor failure, malformed/unfinished reply and verifier failure keep the original', async () => {
  for (const responses of [[new Error('secret-private-value')],
    [{ ...deepseek(edited), choices: [{ finish_reason: 'length' }] }],
    [{ choices: [{ finish_reason: 'stop', message: { content: '{bad' } }] }],
    [deepseek(edited), new Error('private-key')], [deepseek(edited), { status: 'incomplete' }]]) {
    const result = await polishDraft(draft, { ...options, fetchImpl: mock(responses).fetchImpl });
    assert.equal(result.text, draft.text);
    assert.equal(result.style.status, 'fallback');
    assert.doesNotMatch(JSON.stringify(result.style), /secret-private|private-key/);
  }
});
test('editor cannot change conditions through extra JSON fields', async () => {
  const response = deepseek(edited);
  response.choices[0].message.content = JSON.stringify({ body: edited, conditions: 'Без регистрации' });
  const io = mock([response]);
  assert.equal((await polishDraft(draft, { ...options, fetchImpl: io.fetchImpl })).style.status, 'fallback');
  assert.equal(io.calls.length, 1);
});
test('missing credential makes no requests', async () => {
  const io = mock([]);
  const result = await polishDraft(draft, { ...options, deepseekKey: '', fetchImpl: io.fetchImpl });
  assert.equal(result.text, draft.text);
  assert.equal(io.calls.length, 0);
});
