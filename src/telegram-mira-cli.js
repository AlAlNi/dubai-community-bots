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
    journal: githubJournal({ token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY }),
  });
  const message = result.status === 'sent'
    ? 'Третья реплика отправлена. Жильё завершило диалог и больше не отвечает в этом тесте.'
    : 'Ответ @mira на вопрос о погоде не найден. Ничего не отправлено. Проверьте доступ бота к ответам и повторите запуск после ответа Миры. Старые или уже полученные другим процессом сообщения могут быть недоступны.';
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, message + '\n');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
