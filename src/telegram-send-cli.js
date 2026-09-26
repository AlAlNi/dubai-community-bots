import { readFile, appendFile } from 'node:fs/promises';
import { githubJournal, sendHousing } from './telegram-send.js';

try {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/develop') {
    throw new Error('Отправка доступна только через Actions на develop');
  }
  let report;
  try { report = JSON.parse(await readFile('incoming/report.json', 'utf8')); }
  catch { throw new Error('Не удалось прочитать отчёт из артефакта поиска'); }
  await sendHousing({ report, draftId: process.env.DRAFT_ID, confirmed: process.env.CONFIRM_REVIEWED === 'true',
    token: process.env.TEST_TELEGRAM_HOUSING_BOT_TOKEN, chatId: process.env.TEST_TELEGRAM_CHAT_ID,
    journal: githubJournal({ token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY }) });
  console.log('Одна карточка отправлена в закрытую тестовую группу.');
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    '## Telegram\n\nОдна проверенная карточка жилья отправлена в тестовую группу. Результат записан в журнал `.delivery/test` ветки `develop`.\n');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
