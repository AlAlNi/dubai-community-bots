import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { discover, researchRequest } from '../src/search.js';
import { createResponse } from '../src/openai.js';
import { runSearch } from '../src/search-runner.js';

const settings = JSON.parse(await readFile(new URL('../config/search.json', import.meta.url)));
const editorial = JSON.parse(await readFile(new URL('../config/editorial.json', import.meta.url)));
const now = '2026-09-26T08:00:00+04:00';
const url = 'https://example.com/fictional-event';
const excerpt = 'Учебная встреча начнётся 26 сентября 2026 года в 18:00 по Дубаю в вымышленном клубе.';
const message = (text, annotations = []) => ({ type: 'message', content: [{ type: 'output_text', text, annotations }] });
const research = { id: 'mock-research', model: 'mock', status: 'completed', usage: { total_tokens: 42 }, output: [
  { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ type: 'url', url }] } },
  message(excerpt, [{ type: 'url_citation', url, title: 'Учебный источник', start_index: 0, end_index: excerpt.length }]),
] };
const material = { title: 'Учебная встреча', topic: 'events', source_url: url, source_name: 'Учебный источник',
  published_at: null, expires_at: '2026-09-26T18:00:00+04:00', event_at: '2026-09-26T18:00:00+04:00',
  location: 'Вымышленный клуб', conditions: 'Уточните у организатора.', facts: [{ text: 'Учебная встреча в клубе.', research_excerpt: excerpt }] };
const extraction = materials => ({ id: 'mock-extraction', model: 'mock', status: 'completed', output: [message(JSON.stringify({ materials }))] });
const mock = responses => {
  const calls = [];
  return { calls, fetchImpl: async (endpoint, options) => {
    calls.push({ endpoint, ...options, body: JSON.parse(options.body) });
    if (!responses.length) throw new Error('Unexpected request');
    const next = responses.shift();
    return { ok: true, status: 200, json: async () => next };
  } };
};
const params = { query: 'Учебные события в Дубае', role: 'events', days: 7, settings, now, apiKey: 'test-placeholder' };

test('research requires live search, caps calls, and extraction accepts cited evidence', async () => {
  const io = mock([research, extraction([material])]);
  const result = await discover({ ...params, fetchImpl: io.fetchImpl });
  assert.equal(io.calls.length, 2);
  assert.equal(io.calls[0].endpoint, 'https://api.openai.com/v1/responses');
  assert.equal(io.calls[0].body.store, false);
  assert.deepEqual(io.calls[0].body.tool_choice, { type: 'web_search' });
  assert.equal(io.calls[0].body.max_tool_calls, 3);
  assert.equal(io.calls[0].body.tools[0].external_web_access, true);
  assert.equal(io.calls[1].body.tools, undefined);
  assert.equal(io.calls[1].body.text.format.strict, true);
  assert.equal(result.materials.length, 1);
  assert.equal(result.materials[0].verification, 'automated_research_needs_review');
  assert.equal(result.materials[0].source_url, url);
});
test('search without citations skips extraction and produces no invented materials', async () => {
  const r = structuredClone(research);
  r.output[1] = message('Подходящих результатов нет.');
  const io = mock([r]);
  assert.equal((await discover({ ...params, fetchImpl: io.fetchImpl })).materials.length, 0);
  assert.equal(io.calls.length, 1);
});
test('uncited URL, invented evidence, expired event and missing time are rejected', async () => {
  for (const change of [{ source_url: 'https://example.com/invented' },
    { facts: [{ text: 'Неверно', research_excerpt: 'Такой фразы в исследовании не было.' }] },
    { event_at: '2026-09-25T12:00:00Z' }, { event_at: null }]) {
    const io = mock([research, extraction([{ ...material, ...change }])]);
    const result = await discover({ ...params, fetchImpl: io.fetchImpl });
    assert.equal(result.materials.length, 0);
    assert.equal(result.rejected.length, 1);
  }
});
test('incomplete responses, malformed JSON and absent web calls fail closed', async () => {
  await assert.rejects(discover({ ...params, fetchImpl: mock([{ ...research, status: 'incomplete' }]).fetchImpl }), /не завершён/);
  await assert.rejects(discover({ ...params, fetchImpl: mock([{ ...research, output: [message('Нет поиска')] }]).fetchImpl }), /веб-поиска/);
  await assert.rejects(discover({ ...params, fetchImpl: mock([research, { status: 'completed', output: [message('broken')] }]).fetchImpl }), /разобрать/);
});
test('HTTP errors and timeout have no retries and do not expose credentials', async () => {
  for (const status of [401, 429, 500]) {
    let calls = 0;
    await assert.rejects(createResponse({}, { apiKey: 'DO_NOT_PRINT', timeoutMs: 1000,
      fetchImpl: async () => { calls++; return { ok: false, status }; } }), error => error.message.includes(String(status)) && !error.message.includes('DO_NOT_PRINT'));
    assert.equal(calls, 1);
  }
  await assert.rejects(createResponse({}, { apiKey: 'DO_NOT_PRINT', timeoutMs: 1000,
    fetchImpl: async () => { throw new Error('DO_NOT_PRINT'); } }), error => /тайм-аут/.test(error.message) && !error.message.includes('DO_NOT_PRINT'));
});
test('runner persists evidence, deduplicates reworded sources, and enforces durable daily limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dubai-search-'));
  const p = { ...params, settings: { ...settings, max_runs_per_day: 2 }, editorial, environment: { name: 'test' }, directory };
  try {
    const first = await runSearch({ ...p, fetchImpl: mock([research, extraction([material])]).fetchImpl });
    assert.equal(first.report.added, 1);
    assert.match(first.report.drafts[0].review_note, /Требуется проверка/);
    assert.doesNotMatch(first.report.drafts[0].text, /Найдено автоматически/);
    assert.equal(JSON.parse(await readFile(first.auditPath)).research.citations[0].url, url);
    const second = await runSearch({ ...p, fetchImpl: mock([research, extraction([{ ...material, title: 'Другой заголовок' }])]).fetchImpl });
    assert.equal(second.report.added, 0);
    assert.equal(second.report.duplicates.length, 1);
    const noCalls = mock([]);
    await assert.rejects(runSearch({ ...p, fetchImpl: noCalls.fetchImpl }), /дневной лимит/);
    assert.equal(noCalls.calls.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('failed extraction keeps research and consumes a slot without replacing existing report', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dubai-search-failure-'));
  const p = { ...params, editorial, environment: { name: 'test' }, directory };
  try {
    const first = await runSearch({ ...p, fetchImpl: mock([research, extraction([material])]).fetchImpl });
    const before = await readFile(first.reportPath, 'utf8');
    await assert.rejects(runSearch({ ...p, fetchImpl: mock([research, { status: 'incomplete' }]).fetchImpl }));
    assert.equal(await readFile(first.reportPath, 'utf8'), before);
    const ledger = JSON.parse(await readFile(join(directory, 'runs.json')));
    assert.equal(ledger.runs.length, 2);
    assert.equal(ledger.runs[1].status, 'failed');
    const audit = JSON.parse(await readFile(join(directory, `${ledger.runs[1].id}.json`)));
    assert.equal(audit.research.citations[0].url, url);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('dry-run works without a key and production is blocked', () => {
  const run = (...args) => spawnSync(process.execPath, ['src/search-cli.js', '--query', 'Маршруты в Дубае', ...args], { encoding: 'utf8' });
  const dry = run('--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).paid_requests, false);
  assert.equal(run('--env', 'production').status, 1);
  assert.throws(() => researchRequest('x', 'guide', 99, settings, now), /Период/);
});

test('optional editor is applied only to new drafts and missing key fails before search', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dubai-style-run-'));
  const styleSettings = JSON.parse(await readFile(new URL('../config/style.json', import.meta.url)));
  const p = { ...params, editorial, environment: { name: 'test' }, directory, style: 'deepseek', styleSettings };
  try {
    const noCalls = mock([]);
    await assert.rejects(runSearch({ ...p, fetchImpl: noCalls.fetchImpl }), /TEST_DEEPSEEK_API_KEY/);
    assert.equal(noCalls.calls.length, 0);
    const editor = { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ body: 'Учебная встреча в клубе.' }) } }] };
    const checker = { status: 'completed', output: [message(JSON.stringify({ supported: true, complete: true, issues: [] }))] };
    const io = mock([research, extraction([material]), editor, checker]);
    const first = await runSearch({ ...p, deepseekKey: 'test-only', fetchImpl: io.fetchImpl });
    assert.equal(io.calls.length, 4);
    assert.equal(first.report.drafts[0].style.status, 'accepted');
    const repeat = mock([research, extraction([material])]);
    const second = await runSearch({ ...p, deepseekKey: 'test-only', fetchImpl: repeat.fetchImpl });
    assert.equal(repeat.calls.length, 2);
    assert.deepEqual(second.report.drafts, JSON.parse(JSON.stringify(first.report.drafts)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
