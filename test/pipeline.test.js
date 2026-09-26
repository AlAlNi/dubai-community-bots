import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepare } from '../src/pipeline.js';

const items = JSON.parse(await readFile(new URL('../examples/materials.json', import.meta.url)));
const config = JSON.parse(await readFile(new URL('../config/editorial.json', import.meta.url)));
const now = '2026-09-26T08:00:00+04:00';
const run = (input, previous = [], date = now) => prepare(input, config, previous, date, true);

test('four roles preserve facts and source; expired material is rejected', () => {
  const r = run(items);
  assert.equal(r.added, 4);
  assert.equal(r.rejected.length, 1);
  for (const d of r.drafts) {
    assert.equal(d.status, 'needs_review');
    assert.ok(d.text.includes(d.material.source_url));
    assert.ok(d.text.startsWith('ДЕМО'));
    d.material.facts.forEach(f => assert.ok(d.text.includes(f)));
  }
  assert.match(r.drafts[1].text, /18:00/);
});
test('duplicates are removed within a batch and after restart, ignoring tracking', () => {
  const duplicate = { ...items[0], id: 'another-id', source_url: items[0].source_url + '?utm_source=test#section' };
  const r = run([items[0], duplicate]);
  assert.equal(r.added, 1);
  assert.equal(r.duplicates.length, 1);
  assert.equal(run([duplicate], r.drafts).added, 0);
});
test('changed source facts produce a new draft', () => {
  const previous = run([items[0]]).drafts;
  assert.equal(run([{ ...items[0], facts: ['Условия изменились.'] }], previous).added, 1);
});
test('malformed, future, stale and missing data are individually rejected', () => {
  const bad = [null, { ...items[0], source_url: '' }, { ...items[0], source_url: 'javascript:alert(1)' },
    { ...items[0], checked_at: 'tomorrow' }, { ...items[0], checked_at: '2026-09-27T08:00:00Z' },
    { ...items[0], checked_at: '2026-09-20T08:00:00Z' }, { ...items[0], role: '__proto__' },
    { ...items[1], location: '' }, { ...items[1], event_at: '2026-09-25T08:00:00Z' }];
  const r = run([...bad, items[0]]);
  assert.equal(r.rejected.length, bad.length);
  assert.equal(r.added, 1);
});
test('sensitive topics remain explicitly marked for review', () => {
  assert.equal(run([{ ...items[3], topic: 'immigration' }]).drafts[0].review_reason, 'sensitive_topic');
});
test('old saved drafts expire on later runs', () => {
  assert.equal(run([], run([items[0]]).drafts, '2026-09-28T08:00:00+04:00').drafts[0].status, 'expired');
});
test('invalid mode fails and overlong post is rejected without truncation', () => {
  assert.throws(() => prepare(items, { ...config, publication_mode: 'live' }), /draft_only/);
  assert.equal(run([{ ...items[0], facts: ['a'.repeat(4100)] }]).rejected.length, 1);
});
test('CLI persists deduplication, rejects mixed modes and preserves corrupt output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dubai-bots-'));
  const output = join(dir, 'report.json');
  const cli = (...args) => spawnSync(process.execPath, ['src/cli.js', ...args], { encoding: 'utf8' });
  try {
    assert.equal(cli('--demo', '--output', output).status, 0);
    assert.equal(JSON.parse(await readFile(output)).added, 4);
    assert.equal(cli('--demo', '--output', output).status, 0);
    const report = JSON.parse(await readFile(output));
    assert.equal(report.added, 0);
    assert.equal(report.drafts.length, 4);
    assert.equal(cli('--demo', '--input', 'examples/materials.json').status, 1);
    await writeFile(output, 'broken');
    assert.equal(cli('--demo', '--output', output).status, 1);
    assert.equal(await readFile(output, 'utf8'), 'broken');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
