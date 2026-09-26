import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectTelegram, TEST_BOT } from '../src/telegram-setup.js';

const now = Date.parse('2026-09-26T12:00:00Z');
const token = '123456:fake_token';
const message = { from: { is_bot: false }, date: now / 1000, text: `/setup@${TEST_BOT}`,
  chat: { id: -123, type: 'group' } };
function mock(overrides = {}) {
  const calls = [];
  const results = { getMe: { is_bot: true, username: TEST_BOT }, getWebhookInfo: { url: '' },
    getUpdates: [{ message }], getChat: { id: -123, type: 'group' }, ...overrides };
  return { calls, fetchImpl: async (url, options) => {
    const method = url.split('/').at(-1);
    calls.push({ method, body: JSON.parse(options.body) });
    assert.ok(Object.hasOwn(results, method), 'only approved read methods');
    return { ok: true, json: async () => ({ ok: true, result: results[method] }) };
  } };
}
test('setup identifies only addressed private group and returns no conversation data', async () => {
  const m = mock();
  assert.deepEqual(await inspectTelegram({ token, now, ...m }), { username: TEST_BOT, chatId: '-123' });
  assert.deepEqual(m.calls.map(c => c.method), ['getMe', 'getWebhookInfo', 'getUpdates', 'getChat']);
  assert.equal(m.calls[2].body.offset, undefined);
});
test('wrong bot and active webhook stop before polling', async () => {
  for (const overrides of [{ getMe: { is_bot: true, username: 'other_bot' } }, { getWebhookInfo: { url: 'https://example.com' } }]) {
    const m = mock(overrides);
    await assert.rejects(inspectTelegram({ token, now, ...m }));
    assert.ok(!m.calls.some(c => c.method === 'getUpdates'));
  }
});
test('ignores private messages, bots, forwards, stale commands and untargeted commands', async () => {
  for (const changes of [{ chat: { id: 123, type: 'private' } }, { from: { is_bot: true } },
    { forward_origin: {} }, { date: now / 1000 - 86401 }, { text: '/setup' }]) {
    await assert.rejects(inspectTelegram({ token, now, ...mock({ getUpdates: [{ message: { ...message, ...changes } }] }) }), /В тестовой группе/);
  }
});
test('ambiguous groups and full update queues fail closed', async () => {
  await assert.rejects(inspectTelegram({ token, now, ...mock({ getUpdates: [{ message }, { message: { ...message, chat: { id: -456, type: 'group' } } }] }) }), /нескольких/);
  await assert.rejects(inspectTelegram({ token, now, ...mock({ getUpdates: Array(100).fill({ message }) }) }), /заполнена/);
});
test('public groups and forums cannot become the test destination', async () => {
  for (const extra of [{ username: 'public_group' }, { active_usernames: ['public_group'] }, { is_forum: true }]) {
    await assert.rejects(inspectTelegram({ token, now, ...mock({ getChat: { id: -123, type: 'supergroup', ...extra } }) }), /закрытая группа/);
  }
});
test('network and provider failures cannot leak token or response text', async () => {
  for (const fetchImpl of [async () => { throw new Error('URL ' + token); },
    async () => ({ ok: false, json: async () => ({ ok: false, description: token }) })]) {
    await assert.rejects(inspectTelegram({ token, now, fetchImpl }), error => !error.message.includes(token));
  }
});
