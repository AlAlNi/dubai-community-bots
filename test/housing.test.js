import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stayPlan, housingMaterials } from '../src/housing.js';
import { researchRequest, sourceUrl, discover } from '../src/search.js';
import { renderPost } from '../src/pipeline.js';
import { runSearch } from '../src/search-runner.js';
const now = '2026-09-26T10:00:00Z';
const stay = stayPlan('2026-10-01', now);
const settings = JSON.parse(await readFile(new URL('../config/search.json', import.meta.url)));
const editorial = JSON.parse(await readFile(new URL('../config/editorial.json', import.meta.url)));
const excerpt = 'Вымышленный отель, Дубай: 2 взрослых без детей, отдельный номер, 1–2 октября 2026, доступен. Полная цена 200 AED со всеми сборами, депозита нет, без возврата.';
const offer = { period: 'day', property: 'Учебный отель', property_type: 'hotel', city: 'Dubai', location: 'Учебный район',
  check_in: '2026-10-01', check_out: '2026-10-02', adults: 2, children: 0, units: 1, private_unit: true, available: true,
  currency: 'AED', total_aed: 200, all_mandatory_fees_included: true, refundable_deposit_aed: 0,
  dates_confirmed: true, guests_confirmed: true, price_text: 'Полная цена 200 AED со всеми сборами', price_basis: 'stay',
  cancellation: 'Без возврата', source_name: 'Учебный источник', source_url: 'https://example.com/hotel', research_excerpt: excerpt };
const research = { text: excerpt, citations: [{ url: offer.source_url }, { url: 'https://example.com/other' }] };
const convert = offers => housingMaterials({ offers }, research, stay, now, sourceUrl);
test('stay dates use Dubai tomorrow and calendar month, including month-end and leap year', () => {
  assert.equal(stayPlan(undefined, '2026-09-26T21:00:00Z').periods[0].check_in, '2026-09-28');
  const p = stayPlan('2028-01-31', now).periods;
  assert.deepEqual(p.map(s => s.nights), [1, 7, 29]);
  assert.equal(p[2].check_out, '2028-02-29');
  assert.equal(stayPlan('2026-12-31', now).periods[2].check_out, '2027-01-31');
  assert.throws(() => stayPlan('2026-02-30', now));
  assert.throws(() => stayPlan('2026-09-25', now));
});
test('ranking uses full stay totals, separate deposits, and never extrapolates weekly/monthly prices', () => {
  const result = convert([offer, { ...offer, source_url: 'https://example.com/other', total_aed: 190, refundable_deposit_aed: 500 }]);
  assert.equal(result.materials.length, 1);
  assert.equal(result.materials[0].housing.total_cents, 19000);
  assert.equal(result.materials[0].housing.deposit_cents, 50000);
  assert.equal(result.comparisons[1].status, 'no_verified_offers');
  assert.equal(result.comparisons[2].count, 0);
  const text = renderPost(result.materials[0], false);
  assert.match(text, /не гарантируются/);
  assert.match(text, /На сайте указано/);
  assert.match(text, /https:\/\/example.com\/other/);
});
test('one offer is not advertised as cheapest and duplicate source entries do not inflate count', () => {
  const result = convert([offer, offer]);
  assert.equal(result.materials[0].housing.compared_count, 1);
  assert.match(result.materials[0].facts[0], /только один/);
  assert.doesNotMatch(result.materials[0].facts[0], /самая низкая|самый дешёвый/i);
});
test('unavailable, wrong dates, occupancy, invalid amounts and invented prices are rejected', () => {
  for (const change of [{ available: false }, { price_text: 'От 100 AED' },
    { total_aed: -1 }, { total_aed: 0 }, { total_aed: 0.001 },
    { adults: 1 }, { children: 1 }, { units: 2 }, { private_unit: false }, { city: 'Sharjah' },
    { check_out: '2026-10-08' }, { source_url: 'https://example.com/uncited' }, { research_excerpt: 'invented excerpt' }]) {
    const result = convert([{ ...offer, ...change }]);
    assert.equal(result.materials.length, 0, JSON.stringify(change));
    assert.equal(result.rejected.length, 1);
  }
});
test('housing request uses all three exact stays and extraction connects to normal search chain', async () => {
  const params = { query: 'Недорогое жильё в Дубае', role: 'housing', days: 7, checkIn: '2026-10-01', settings, now, apiKey: 'test-only' };
  const req = researchRequest(params.query, 'housing', 7, settings, now, params.checkIn);
  assert.deepEqual(JSON.parse(req.input).stay, stay);
  const result = await discover({ ...params, fetchImpl: fakeSearch() });
  assert.equal(result.materials[0].role, 'housing');
  assert.equal(result.comparisons.length, 3);
  assert.equal(Date.parse(result.materials[0].expires_at) - Date.parse(now), 3600000);
});
function fakeSearch(quality = true, candidate = offer, researchText = excerpt) {
  const message = text => ({ type: 'message', content: [{ type: 'output_text', text, annotations: [{ type: 'url_citation', url: offer.source_url }] }] });
  const responses = [
    { status: 'completed', output: [{ type: 'web_search_call', status: 'completed' }, message(researchText)] },
    { status: 'completed', output: [message(JSON.stringify({ offers: [candidate] }))] },
    { status: 'completed', output: [message(JSON.stringify({ source_consistent: quality, supported: quality, complete: true, non_redundant: true, issues: quality ? [] : ['Цена не подтверждена на даты.'] }))] },
  ];
  return async () => { assert.ok(responses.length); return { ok: true, json: async () => responses.shift() }; };
}
test('research that asks a question without citations cannot produce offers or call extraction', async () => {
  let calls = 0;
  const result = await discover({ query: 'Жильё', role: 'housing', days: 7, settings, now, apiKey: 'test-only',
    fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ status: 'completed', output: [
      { type: 'web_search_call', status: 'completed', action: { sources: [{ url: offer.source_url }] } },
      { type: 'message', content: [{ type: 'output_text', text: 'Только дешёвые или разные уровни?', annotations: [] }] },
    ] }) }; } });
  assert.equal(calls, 1);
  assert.equal(result.materials.length, 0);
  assert.equal(result.rejected[0].code, 'research_no_citations');
  assert.equal(result.extraction, null);
  assert.equal(result.comparisons.length, 3);
});

const partialExcerpt = 'Учебные апартаменты в Дубае, отдельное жильё. На странице указано: от 150 AED за ночь. Сборы, депозит, гости и наличие на даты не указаны.';
const partial = { ...offer, total_aed: null, all_mandatory_fees_included: null, refundable_deposit_aed: null,
  check_in: null, check_out: null, adults: null, children: null, units: null, available: null,
  dates_confirmed: false, guests_confirmed: false, price_text: 'от 150 AED за ночь', price_basis: 'from', cancellation: 'Не указана', research_excerpt: partialExcerpt };
const partialResearch = { ...research, text: partialExcerpt };
test('informational quote preserves from/night and unknowns without computing a total', () => {
  const r = housingMaterials({ offers: [{ ...partial, period: 'month' }] }, partialResearch, stay, now, sourceUrl);
  assert.equal(r.comparisons[2].count, 0);
  assert.equal(r.comparisons[2].informational_count, 1);
  const h = r.materials[0].housing;
  assert.equal(h.mode, 'informational');
  assert.equal(h.total_cents, null);
  assert.equal(h.compared_count, 0);
  const text = renderPost(r.materials[0], false);
  assert.match(text, /от 150 AED за ночь/);
  assert.match(text, /Депозит неизвестен/);
  assert.match(text, /Наличие на даты нужно проверить/);
  assert.match(text, /Цена для 2 взрослых не подтверждена/);
  assert.doesNotMatch(text, /самая низкая|самый дешёвый|4650|4500/);
});
test('partial offers never enter full-price ranking or inflate comparison count', () => {
  const r = housingMaterials({ offers: [partial, offer] }, { ...research, text: excerpt + '\n' + partialExcerpt }, stay, now, sourceUrl);
  assert.equal(r.comparisons[0].count, 1);
  assert.equal(r.comparisons[0].informational_count, 1);
  assert.equal(r.materials[0].housing.mode, 'comparison');
  assert.equal(r.materials[0].housing.compared_count, 1);
});
test('unknown deposit, fees or price basis downgrades to informational rather than a cheap winner', () => {
  for (const change of [{ refundable_deposit_aed: null }, { all_mandatory_fees_included: null },
    { all_mandatory_fees_included: false }, { available: null }, { price_basis: 'night' }, { price_basis: 'month' },
    { price_basis: 'from' }, { dates_confirmed: false }, { guests_confirmed: false }, { currency: 'USD' }]) {
    const r = convert([{ ...offer, ...change }]);
    assert.equal(r.materials[0].housing.mode, 'informational');
    assert.equal(r.comparisons[0].count, 0);
  }
});

test('confirmed occupancy describes only the actual property type in both housing modes', () => {
  for (const property_type of ['hotel', 'apartment']) for (const refundable_deposit_aed of [0, null]) {
    const m = convert([{ ...offer, property_type, refundable_deposit_aed }]).materials[0];
    const text = renderPost(m, false);
    assert.match(text, property_type === 'hotel' ? /один отдельный номер/ : /целые апартаменты/);
    assert.doesNotMatch(text, /номер или апартаменты|1 целые/);
    if (property_type === 'hotel') assert.doesNotMatch(text, /апартаменты/);
  }
});
test('informational cards still pass through quality checker and report selected draft status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dubai-info-'));
  try {
    const r = await runSearch({ query: 'Жильё', role: 'housing', days: 7, checkIn: '2026-10-01', now,
      settings, editorial, environment: { name: 'test' }, apiKey: 'test-only', directory, fetchImpl: fakeSearch(true, partial, partialExcerpt) });
    assert.equal(r.report.housing_search.periods[0].count, 0);
    assert.equal(r.report.housing_search.periods[0].status, 'needs_review');
    assert.equal(r.report.drafts[0].style.status, 'checked');
    assert.match(await readFile(join(directory, 'drafts.md'), 'utf8'), /от 150 AED за ночь/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('housing report preserves comparison and gates winning offer through consistency checker', async () => {
  for (const quality of [true, false]) {
    const directory = await mkdtemp(join(tmpdir(), 'dubai-housing-'));
    try {
      const result = await runSearch({ query: 'Жильё', role: 'housing', days: 7, checkIn: '2026-10-01', now,
        settings, editorial, environment: { name: 'test' }, apiKey: 'test-only', directory, fetchImpl: fakeSearch(quality) });
      assert.equal(result.report.housing_search.periods[0].status, quality ? 'needs_review' : 'blocked');
      assert.equal(result.report.housing_search.periods[1].status, 'no_verified_offers');
      if (!quality) assert.equal(result.report.drafts[0].text, null);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
