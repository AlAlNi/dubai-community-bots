import { appendFile } from 'node:fs/promises';
import { githubJournal } from './telegram-send.js';
import { runDialogue } from './telegram-dialogue.js';

try {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/develop') {
    throw new Error('Запустите Telegram free dialogue (test) из develop');
  }
  const result = await runDialogue({
    token: process.env.TEST_TELEGRAM_HOUSING_BOT_TOKEN,
    chatId: process.env.TEST_TELEGRAM_CHAT_ID,
    apiKey: process.env.TEST_OPENAI_API_KEY,
    journal: githubJournal({ token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY }),
    progress: ({ housing_sent }) => console.log(`Отправлена реплика «Жилья»: ${housing_sent}/5`),
  });
  const reason = result.stop === 'limit' ? 'Достигнут лимит пяти реплик.'
    : result.stop === 'mira_timeout' ? 'Ответ Миры не получен за время ожидания.' : 'Истекло время эксперимента.';
  const summary = `«Жильё» остановлено. Отправлено: ${result.housingSent}/5; вызовов OpenAI: ${result.openaiCalls}/5. ${reason}`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
