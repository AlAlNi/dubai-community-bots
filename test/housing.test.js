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
test('unknown fees, deposit, availability, wrong dates, currency or occupancy cannot win', () => {
  for (const change of [{ all_mandatory_fees_included: false }, { refundable_deposit_aed: null }, { available: false },
    { total_aed: null }, { total_aed: -1 }, { total_aed: 0 }, { total_aed: 0.001 }, { currency: 'USD' },
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
function fakeSearch(quality = true) {
  const message = text => ({ type: 'message', content: [{ type: 'output_text', text, annotations: [{ type: 'url_citation', url: offer.source_url }] }] });
  const responses = [
    { status: 'completed', output: [{ type: 'web_search_call', status: 'completed' }, message(excerpt)] },
    { status: 'completed', output: [message(JSON.stringify({ offers: [offer] }))] },
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
