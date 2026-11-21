import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDialogueTranscript } from '../src/dialogue-transcript.js';

test('transcript preserves readable turns, redacts secrets, excludes extra fields and survives partial failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dubai-transcript-'));
  const writer = await createDialogueTranscript(directory, ['secret-token', undefined, '']);
  await writer.turn({ speaker: 'housing', text: 'Привет!\nsecret-token', at: '2026-11-21T11:00:00Z', chat_id: -123 });
  await writer.turn({ speaker: 'mira', text: 'А вот моя мысль.', at: '2026-11-21T11:00:02Z' });
  const partial = await readFile(join(directory, 'dialogue.jsonl'), 'utf8');
  assert.equal(partial.trim().split('\n').length, 2);
  assert.ok(!partial.includes('secret-token'));
  assert.ok(!partial.includes('chat_id'));
  await writer.finish('error', 'Ошибка без повторной отправки');
  const records = (await readFile(join(directory, 'dialogue.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records[0].text, 'Привет!\n[REDACTED]');
  assert.equal(records[1].speaker, 'mira');
  assert.equal(records[2].recorded_messages, 2);
  const markdown = await readFile(join(directory, 'dialogue.md'), 'utf8');
  assert.match(markdown, /## 1\. Жильё/);
  assert.match(markdown, /> Привет!\n> \[REDACTED\]/);
  assert.match(markdown, /Ошибка без повторной отправки/);
});
