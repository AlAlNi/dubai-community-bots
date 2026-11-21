import { appendFile } from 'node:fs/promises';
import { githubJournal } from './telegram-send.js';
import { replyToMira } from './telegram-mira.js';

try {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/develop') {
    throw new Error('Запустите Telegram reply to Mira (test) из develop');
  }
  const result = await replyToMira({
    token: process.env.TEST_TELEGRAM_HOUSING_BOT_TOKEN,
    chatId: process.env.TEST_TELEGRAM_CHAT_ID,
    diagnosticOnly: process.env.TEST_MIRA_DIAGNOSTIC_ONLY === 'true',
    onDiagnostic: data => console.log('MIRA_DIAGNOSTIC ' + JSON.stringify(data)),
    journal: githubJournal({ token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY }),
  });
  const message = result.status === 'sent'
    ? 'Третья реплика отправлена. Жильё завершило диалог и больше не отвечает в этом тесте.'
    : result.status === 'diagnostic'
      ? 'Диагностика завершена без отправки. Счётчики и причины фильтрации — в строках MIRA_DIAGNOSTIC журнала шага.'
      : 'Ответ @mira на вопрос о погоде не найден. Ничего не отправлено. Причины фильтрации — в строках MIRA_DIAGNOSTIC журнала шага.';
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, message + '\n');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
