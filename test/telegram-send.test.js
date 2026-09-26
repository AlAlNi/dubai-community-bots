import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedDraft, githubJournal, sendHousing } from '../src/telegram-send.js';
import { TEST_BOT } from '../src/telegram-setup.js';

const time = Date.parse('2026-09-26T12:00:00Z');
function report() {
  return { version: 1, environment: 'test', demo: false, drafts: [{
    demo: false, role: 'housing', status: 'needs_review', text: 'Нашёл предложение — https://example.com',
    material: { id: 'offer1', role: 'housing', discovery_key: 'stable-offer',
      checked_at: '2026-09-26T11:45:00Z', expires_at: '2026-09-26T12:45:00Z' },
    style: { status: 'checked', verdict: { source_consistent: true, supported: true, complete: true, non_redundant: true, issues: [] } },
  }] };
}
function fixture() {
  const calls = [], records = new Map();
  const args = { report: report(), draftId: 'offer1', confirmed: true, token: '123:fake', chatId: '-123', now: () => time,
    journal: {
      reserve: async (key, record) => {
        calls.push('reserve');
        if (records.has(key)) throw new Error('duplicate');
        records.set(key, record);
        return 'sha';
      },
      finish: async (key, record) => { calls.push('finish'); records.set(key, record); },
    },
    fetchImpl: async (url, options) => {
      const method = url.split('/').at(-1);
      calls.push(method);
      const body = JSON.parse(options.body);
      if (method === 'sendMessage') {
        assert.equal(body.text, args.report.drafts[0].text);
        assert.equal(body.chat_id, '-123');
        assert.equal(body.parse_mode, undefined);
      }
      return { ok: true, json: async () => ({ ok: true, result: {
        getMe: { is_bot: true, username: TEST_BOT }, getChat: { id: -123, type: 'group' },
        sendMessage: { message_id: 7, chat: { id: -123 } },
      }[method] }) };
    },
  };
  return { args, calls, records };
}
test('sends unchanged approved text once, with durable reservation before sending', async () => {
  const { args, calls, records } = fixture();
  assert.deepEqual(await sendHousing(args), { status: 'sent' });
  assert.deepEqual(calls, ['getMe', 'getChat', 'reserve', 'sendMessage', 'finish']);
  assert.equal([...records.values()][0].status, 'sent');
  await assert.rejects(sendHousing(args), /duplicate/);
  assert.equal(calls.filter(c => c === 'sendMessage').length, 1);
});
test('demo, production, blocked, unchecked, uncertain and stale drafts never reach network', async () => {
  const edits = [r => r.demo = true, r => r.environment = 'production', r => r.drafts[0].status = 'blocked',
    r => delete r.drafts[0].style, r => r.drafts[0].style.verdict.issues.push('uncertain'),
    r => r.drafts[0].material.expires_at = '2026-09-26T11:59:00Z',
    r => r.drafts[0].material.checked_at = '2026-09-26T13:00:00Z',
    r => r.drafts.push(structuredClone(r.drafts[0])), r => r.drafts[0].text = 'x'.repeat(4001),
    ...['source_consistent', 'supported', 'complete', 'non_redundant'].map(k => r => r.drafts[0].style.verdict[k] = false)];
  for (const edit of edits) {
    const { args, calls } = fixture(); edit(args.report);
    await assert.rejects(sendHousing(args));
    assert.deepEqual(calls, []);
  }
  assert.throws(() => approvedDraft(report(), 'offer1', false, time), /ручную/);
});
test('reservation failure, including concurrent duplicate, prevents send', async () => {
  const { args, calls } = fixture();
  const results = await Promise.allSettled([sendHousing(args), sendHousing(args)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(calls.filter(c => c === 'sendMessage').length, 1);
});
test('ambiguous Telegram reply retains reservation, leaks no credentials and is never retried', async () => {
  const { args, calls, records } = fixture();
  const original = args.fetchImpl;
  args.fetchImpl = async (url, options) => {
    if (url.endsWith('/sendMessage')) { calls.push('sendMessage'); throw new Error(url); }
    return original(url, options);
  };
  await assert.rejects(sendHousing(args), e => !e.message.includes(args.token) && /повтора нет/.test(e.message));
  assert.equal([...records.values()][0].status, 'reserved');
  await assert.rejects(sendHousing(args), /duplicate/);
  assert.equal(calls.filter(c => c === 'sendMessage').length, 1);
});
test('expired during preflight is stopped after reservation; wrong bot or public chat cannot reserve', async () => {
  const f = fixture(); let clock = 0;
  f.args.now = () => ++clock < 3 ? time : time + 3600000;
  await assert.rejects(sendHousing(f.args), /устарела/);
  assert.ok(!f.calls.includes('sendMessage'));
  for (const bad of [{ is_bot: true, username: 'wrong_bot' }, { id: -123, type: 'supergroup', username: 'public' }]) {
    const { args, calls } = fixture();
    const original = args.fetchImpl;
    args.fetchImpl = async (url, options) => {
      if (url.endsWith(bad.id ? '/getChat' : '/getMe')) return { ok: true, json: async () => ({ ok: true, result: bad }) };
      return original(url, options);
    };
    await assert.rejects(sendHousing(args));
    assert.ok(!calls.includes('reserve'));
  }
});
test('successful send followed by journal failure stays reserved and reports delivery', async () => {
  const { args, records } = fixture();
  args.journal.finish = async () => { throw new Error('failed'); };
  await assert.rejects(sendHousing(args), /Telegram подтвердил отправку/);
  assert.equal([...records.values()][0].status, 'reserved');
});
test('GitHub journal creates without SHA, updates with SHA and rejects conflicts without leaking bodies', async () => {
  const requests = [];
  const journal = githubJournal({ token: 'fake_secret', repository: 'AlAlNi/dubai-community-bots',
    fetchImpl: async (url, options) => { requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ content: { sha: 'blobsha' } }) }; } });
  const sha = await journal.reserve('abc', { status: 'reserved' });
  await journal.finish('abc', { status: 'sent' }, sha);
  assert.equal(requests[0].sha, undefined);
  assert.equal(requests[1].sha, 'blobsha');
  assert.equal(requests[0].branch, 'develop');
  const conflict = githubJournal({ token: 'fake_secret', repository: 'AlAlNi/dubai-community-bots',
    fetchImpl: async () => ({ ok: false, json: async () => ({ message: 'fake_secret' }) }) });
  await assert.rejects(conflict.reserve('abc', {}), e => !e.message.includes('fake_secret'));
});
