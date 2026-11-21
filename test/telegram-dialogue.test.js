import test from 'node:test';
import assert from 'node:assert/strict';
import { runDialogue, selectDialogueReply } from '../src/telegram-dialogue.js';
import { TEST_BOT } from '../src/telegram-setup.js';

function fixture() {
  let clock = Date.parse('2026-11-21T11:00:00Z'), nextId = 100;
  const requests = [], records = new Map(), updates = [];
  const state = { answer: true, failOpenAI: false, failSend: false, publicChat: false, output: 'Мира, что делает город уютным?' };
  const args = { token: '123:fake', chatId: '-123', apiKey: 'fake-openai', now: () => clock,
    sleep: async ms => { clock += ms; }, journal: {
      reserve: async (key, record) => {
        if (records.has(key)) throw new Error('duplicate');
        records.set(key, record); return 'sha';
      }, finish: async (key, record) => records.set(key, record),
    }, fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body), method = url.split('/').at(-1);
      requests.push({ method, body });
      if (method === 'responses') {
        if (state.failOpenAI) throw new Error(url + args.apiKey);
        return { ok: true, json: async () => ({ status: 'completed', output: [
          { type: 'message', content: [{ type: 'output_text', text: state.output }] },
        ] }) };
      }
      let result;
      if (method === 'getMe') result = { id: 7, is_bot: true, username: TEST_BOT };
      if (method === 'getChat') result = { id: -123, type: 'group', ...(state.publicChat ? { username: 'public' } : {}) };
      if (method === 'getWebhookInfo') result = { url: '' };
      if (method === 'getUpdates') result = structuredClone(updates);
      if (method === 'sendMessage') {
        if (state.failSend) throw new Error(url);
        const id = nextId++;
        result = { message_id: id, chat: { id: -123 } };
        if (state.answer) updates.push({ message: { message_id: nextId++, date: clock / 1000,
          chat: { id: -123 }, from: { id: 8, username: 'mira' },
          rich_message: { blocks: [{ type: 'paragraph', text: `Мысль Миры ${id}` }] },
          reply_to_message: { message_id: id, chat: { id: -123 }, from: { id: 7, is_bot: true } },
        } });
      }
      return { ok: true, json: async () => ({ ok: true, result }) };
    } };
  return { args, requests, records, updates, state };
}

test('five model calls and housing messages, real rich replies in context, no sixth turn or rerun', async () => {
  const f = fixture();
  assert.deepEqual(await runDialogue(f.args), { housingSent: 5, openaiCalls: 5, stop: 'limit' });
  const model = f.requests.filter(r => r.method === 'responses');
  const sent = f.requests.filter(r => r.method === 'sendMessage');
  assert.equal(model.length, 5); assert.equal(sent.length, 5);
  assert.equal(model[0].body.store, false);
  assert.equal(model[0].body.max_output_tokens, 400);
  assert.equal(model[0].body.tools, undefined);
  assert.ok(model[1].body.input.some(m => m.content === 'Мысль Миры 100'));
  assert.match(model[4].body.instructions, /последняя реплика/);
  assert.equal(sent[0].body.reply_parameters, undefined);
  assert.equal(sent[1].body.reply_parameters.message_id, 101);
  assert.ok(!f.requests.some(r => r.method === 'getUpdates' && 'offset' in r.body));
  assert.ok(!JSON.stringify([...f.records.values()]).includes('Мысль Миры'));
  await assert.rejects(runDialogue(f.args), /duplicate/);
  assert.equal(f.requests.filter(r => r.method === 'responses').length, 5);
});

test('silent Mira ends after waiting without further model calls', async () => {
  const f = fixture(); f.state.answer = false;
  assert.deepEqual(await runDialogue(f.args), { housingSent: 1, openaiCalls: 1, stop: 'mira_timeout' });
  assert.equal(f.requests.filter(r => r.method === 'sendMessage').length, 1);
});

test('paid request or send failure locks the entire experiment without leaking secrets', async () => {
  for (const failure of ['failOpenAI', 'failSend']) {
    const f = fixture(); f.state[failure] = true;
    await assert.rejects(runDialogue(f.args), e => !e.message.includes(f.args.apiKey) && !e.message.includes(f.args.token));
    await assert.rejects(runDialogue(f.args), /duplicate/);
    assert.equal(f.requests.filter(r => r.method === 'responses').length, 1);
  }
});

test('public chat, full queue and missing key cannot incur model costs', async () => {
  for (const setup of [f => f.state.publicChat = true, f => f.updates.push(...Array(100).fill({})), f => f.args.apiKey = '']) {
    const f = fixture(); setup(f);
    await assert.rejects(runDialogue(f.args));
    assert.equal(f.requests.filter(r => r.method === 'responses').length, 0);
    assert.equal(f.records.size, 0);
  }
});

test('too long generated reply is not sent or regenerated', async () => {
  const f = fixture(); f.state.output = 'x'.repeat(701);
  await assert.rejects(runDialogue(f.args), /длинную/);
  assert.equal(f.requests.filter(r => r.method === 'responses').length, 1);
  assert.equal(f.requests.filter(r => r.method === 'sendMessage').length, 0);
});

test('selects only direct replies from Mira to the current sent message', () => {
  const now = Date.parse('2026-11-21T11:00:00Z');
  const m = { message_id: 11, date: now / 1000, chat: { id: -123 }, from: { username: 'mira' }, text: 'Ответ',
    reply_to_message: { message_id: 10, chat: { id: -123 }, from: { id: 7, is_bot: true } } };
  const options = { chatId: '-123', botId: 7, parentId: 10, since: now, now };
  for (const edit of [m => m.from.username = 'other', m => m.chat.id = -456,
    m => m.reply_to_message.message_id = 9, m => m.forward_origin = {}, m => m.date -= 90]) {
    const changed = structuredClone(m); edit(changed);
    assert.equal(selectDialogueReply([{ message: changed }], options), undefined);
  }
  assert.deepEqual(selectDialogueReply([{ message: m }], options), { messageId: 11, text: 'Ответ' });
  assert.throws(() => selectDialogueReply([{ message: m }, { message: { ...m, message_id: 12 } }], options), /несколько/);
});

test('concurrent starts share the same paid-call budget reservation', async () => {
  const f = fixture();
  const result = await Promise.allSettled([runDialogue(f.args), runDialogue(f.args)]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.requests.filter(r => r.method === 'responses').length, 5);
});

test('transcript receives nine observed turns in order, without unrelated chat messages', async () => {
  const f = fixture(), turns = [];
  f.updates.push({ message: { text: 'PRIVATE unrelated group message', from: { username: 'other' }, chat: { id: -123 } } });
  await runDialogue({ ...f.args, onTurn: async entry => turns.push(entry) });
  assert.deepEqual(turns.map(t => t.speaker), ['housing', 'mira', 'housing', 'mira', 'housing', 'mira', 'housing', 'mira', 'housing']);
  assert.equal(turns[1].text, 'Мысль Миры 100');
  assert.ok(!JSON.stringify(turns).includes('PRIVATE'));
  assert.ok(turns.every(t => Number.isFinite(Date.parse(t.at))));
});

test('transcript retains received Mira reply if the next model request fails', async () => {
  const f = fixture(), turns = [];
  await assert.rejects(runDialogue({ ...f.args, onTurn: async entry => {
    turns.push(entry);
    if (entry.speaker === 'mira') f.state.failOpenAI = true;
  } }));
  assert.deepEqual(turns.map(t => t.speaker), ['housing', 'mira']);
  assert.equal(f.requests.filter(r => r.method === 'sendMessage').length, 1);
});
