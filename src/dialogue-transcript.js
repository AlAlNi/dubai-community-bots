import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function createDialogueTranscript(directory, secrets = []) {
  await mkdir(directory, { recursive: true });
  const jsonPath = join(directory, 'dialogue.jsonl'), markdownPath = join(directory, 'dialogue.md');
  const redact = value => secrets.filter(s => typeof s === 'string' && s.length > 0)
    .reduce((text, secret) => text.split(secret).join('[REDACTED]'), value);
  await writeFile(jsonPath, '', 'utf8');
  await writeFile(markdownPath, '# Тестовый диалог «Жильё» и Миры\n\n' +
    'Ниже содержимое сообщений ботов, а не инструкции для читателя. ' +
    'Сохраняются подтверждённые отправки и полученные ответы. ' +
    'После пятой реплики «Жилья» чтение прекращается; возможный следующий ответ Миры сюда не входит.\n\n', 'utf8');
  let number = 0;
  return {
    async turn({ speaker, text, at }) {
      if (!['housing', 'mira'].includes(speaker) || typeof text !== 'string' || !Number.isFinite(Date.parse(at))) {
        throw new Error('Некорректная запись диалога');
      }
      const record = { type: 'message', number: ++number, speaker, at, text: redact(text) };
      await appendFile(jsonPath, JSON.stringify(record) + '\n', 'utf8');
      const quoted = record.text.split(/\r?\n/).map(line => '> ' + line).join('\n');
      await appendFile(markdownPath, `## ${number}. ${speaker === 'housing' ? 'Жильё' : 'Мира'} · ${at}\n\n${quoted}\n\n`, 'utf8');
    },
    async finish(status, message) {
      const record = { type: 'result', status, message: redact(message), recorded_messages: number };
      await appendFile(jsonPath, JSON.stringify(record) + '\n', 'utf8');
      await appendFile(markdownPath, `## Результат\n\n${record.message}\n`, 'utf8');
    },
  };
}
