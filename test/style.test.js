import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepare, renderPost } from '../src/pipeline.js';
import { polishDraft, checkDraft, verificationRequest } from '../src/style.js';

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
const verdict = (supported = true, complete = true, issues = [], extra = {}) => ({ id: 'check-test', model: 'test', status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ source_consistent: true, non_redundant: true, supported, complete, issues, ...extra }) }] }] });
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
    assert.equal(result.text, null);
    assert.equal(result.original_text, draft.text);
    assert.equal(result.status, 'blocked');
    assert.equal(io.calls.length, 1);
  }
});
test('changed meaning, missing condition or uncertainty blocks publication even without new numbers', async () => {
  for (const check of [verdict(false, true, ['Выдуманная аудитория']), verdict(true, false, ['Потеряно окончание']), verdict(true, true, ['Есть сомнения'])]) {
    const io = mock([deepseek('Подходит всем детям, регистрация не нужна.'), check]);
    const result = await polishDraft(draft, { ...options, fetchImpl: io.fetchImpl });
    assert.equal(result.text, null);
    assert.equal(result.original_text, draft.text);
    assert.equal(result.status, 'blocked');
    assert.ok(result.style.verdict.issues.length);
  }
});
test('editor and verifier failures retain original only for review and block publication', async () => {
  for (const responses of [[new Error('secret-private-value')],
    [{ ...deepseek(edited), choices: [{ finish_reason: 'length' }] }],
    [{ choices: [{ finish_reason: 'stop', message: { content: '{bad' } }] }],
    [deepseek(edited), new Error('private-key')], [deepseek(edited), { status: 'incomplete' }]]) {
    const result = await polishDraft(draft, { ...options, fetchImpl: mock(responses).fetchImpl });
    assert.equal(result.text, null);
    assert.equal(result.original_text, draft.text);
    assert.equal(result.style.status, 'blocked');
    assert.doesNotMatch(JSON.stringify(result.style), /secret-private|private-key/);
  }
});
test('editor cannot change conditions through extra JSON fields', async () => {
  const response = deepseek(edited);
  response.choices[0].message.content = JSON.stringify({ body: edited, conditions: 'Без регистрации' });
  const io = mock([response]);
  assert.equal((await polishDraft(draft, { ...options, fetchImpl: io.fetchImpl })).style.status, 'blocked');
  assert.equal(io.calls.length, 1);
});
test('missing credential makes no requests', async () => {
  const io = mock([]);
  const result = await polishDraft(draft, { ...options, deepseekKey: '', fetchImpl: io.fetchImpl });
  assert.equal(result.original_text, draft.text);
  assert.equal(result.text, null);
  assert.equal(io.calls.length, 0);
});

test('conflicting child supervision cannot pass even when the edited text is supported and complete', async () => {
  const conflict = { ...material, facts: ['Дети должны быть со взрослыми.'], conditions: 'Детям рекомендуется сопровождение взрослых.' };
  const input = { ...draft, material: conflict, text: renderPost(conflict, false) };
  const io = mock([verdict(true, true, ['Обязательное сопровождение стало рекомендованным.'], { source_consistent: false })]);
  const result = await checkDraft(input, { ...options, fetchImpl: io.fetchImpl });
  assert.equal(result.status, 'blocked');
  assert.equal(result.review_reason, 'source_conflict');
  assert.equal(result.text, null);
  assert.equal(result.original_text, input.text);
  const source = JSON.parse(io.calls[0].body.input).source;
  assert.deepEqual(source.facts, conflict.facts);
  assert.equal(source.conditions, conflict.conditions);
  assert.match(io.calls[0].body.instructions, /конфликт обязательности/);
});

test('semantic repetitions are blocked even when supported and complete', async () => {
  const result = await polishDraft(draft, { ...options, fetchImpl: mock([
    deepseek('Начало в 18:00. Вход бесплатный, нужна регистрация.'),
    verdict(true, true, ['Повтор начала и условий.'], { non_redundant: false }),
  ]).fetchImpl });
  assert.equal(result.review_reason, 'repeated_facts');
  assert.equal(result.text, null);
});

test('empty body keeps immutable details once and works for any role', () => {
  const item = { ...material, role: 'transport' };
  const rendered = renderPost(item, false, '');
  for (const value of [item.location, item.conditions, '18:00']) assert.equal(rendered.split(value).length - 1, 1);
  const exact = renderPost(item, false, [item.title, item.location, item.conditions, 'Дополнительный факт.', 'Дополнительный факт.'].join('\n'));
  assert.equal(exact.split('Дополнительный факт.').length - 1, 1);
  assert.equal(exact.split(item.conditions).length - 1, 1);
});

test('missing new verdict fields fails closed and schema requires independent checks', async () => {
  const result = await checkDraft(draft, { ...options, fetchImpl: mock([verdict(true, true, [], { source_consistent: undefined })]).fetchImpl });
  assert.equal(result.review_reason, 'verifier_failed');
  assert.equal(result.text, null);
  const schema = verificationRequest(material, draft.text, settings).text.format.schema;
  assert.ok(schema.required.includes('source_consistent'));
  assert.ok(schema.required.includes('non_redundant'));
});

test('deduplication preserves end time, negative values and distinct numeric punctuation', () => {
  const body = 'Начало в 18:00, окончание в 20:00.\nТемпература -5 градусов.\nТемпература 5 градусов.\nЗначение 1.5.\nЗначение 1,5.';
  const output = renderPost(material, false, body);
  for (const line of body.split('\n')) assert.ok(output.includes(line));
});

test('verifier receives search metadata independently of unknown provider occupancy', () => {
  const m = { ...material, role: 'housing', housing: { mode: 'informational', adults: null,
    requested_check_in: '2026-10-01', requested_check_out: '2026-11-01' } };
  const req = verificationRequest(m, 'Искали для 2 взрослых.', settings);
  const input = JSON.parse(req.input);
  assert.equal(input.application_context.found_at, material.checked_at);
  assert.equal(input.application_context.housing_search.adults, 2);
  assert.equal(input.application_context.housing_search.check_in, '2026-10-01');
  assert.equal(input.source.housing.adults, null);
  assert.ok(input.application_context.editorial_notices.includes('Цена может измениться.'));
  assert.match(req.instructions, /разрешена без цитаты источника/);
  assert.match(req.instructions, /такие утверждения всё равно требуют evidence/);
  assert.match(req.instructions, /studio — студия целиком/);
  assert.match(req.instructions, /private_unit=true всё равно требует подтверждения evidence/);
});
