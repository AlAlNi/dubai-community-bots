import { appendFile } from 'node:fs/promises';
import { githubJournal } from './telegram-send.js';
import { runDialogue } from './telegram-dialogue.js';
import { createDialogueTranscript } from './dialogue-transcript.js';

let transcript;
try {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/develop') {
    throw new Error('Запустите тестовый диалог из develop');
  }
  transcript = await createDialogueTranscript('logs/dialogue', [process.env.TEST_OPENAI_API_KEY,
    process.env.TEST_TELEGRAM_HOUSING_BOT_TOKEN, process.env.TEST_TELEGRAM_CHAT_ID, process.env.GITHUB_TOKEN]);
  const result = await runDialogue({
    mode: process.env.TEST_DIALOGUE_MODE || 'free',
    token: process.env.TEST_TELEGRAM_HOUSING_BOT_TOKEN,
    chatId: process.env.TEST_TELEGRAM_CHAT_ID,
    apiKey: process.env.TEST_OPENAI_API_KEY,
    journal: githubJournal({ token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY }),
    progress: ({ housing_sent }) => console.log(`Отправлена реплика «Жилья»: ${housing_sent}/5`),
    onTurn: entry => transcript.turn(entry),
  });
  const reason = result.stop === 'limit' ? 'Достигнут лимит пяти реплик.'
    : result.stop === 'mira_timeout' ? 'Ответ Миры не получен за время ожидания.' : 'Истекло время эксперимента.';
  const summary = `«Жильё» остановлено. Отправлено: ${result.housingSent}/5; вызовов OpenAI: ${result.openaiCalls}/5. ${reason}`;
  console.log(summary);
  await transcript.finish(result.stop, summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
} catch (error) {
  console.error(error.message);
  if (transcript) {
    try { await transcript.finish('error', 'Эксперимент остановлен с ошибкой. Сохранены доступные реплики; подробности в журнале Actions.'); }
    catch { console.error('Не удалось завершить файл диалога; ранее записанные реплики могут сохраниться в артефакте'); }
  }
  process.exitCode = 1;
}
