import { readFile } from 'node:fs/promises';
import { testPreview } from './telegram-preview.js';
import { githubJournal, sendTestText } from './telegram-send.js';

try {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/develop'
    || !/^\d+$/.test(process.env.GITHUB_RUN_ID ?? '')) throw new Error('Тестовый просмотр доступен только в Actions на develop');
  let report;
  try { report = JSON.parse(await readFile('data/test/search/report.json', 'utf8')); }
  catch { throw new Error('Отчёт не создан: проверьте ошибку шага поиска'); }
  const text = testPreview(report, process.env.SEARCH_ROLE);
  await sendTestText({ text, identity: `preview:${process.env.GITHUB_RUN_ID}`,
    token: process.env.TEST_TELEGRAM_HOUSING_BOT_TOKEN, chatId: process.env.TEST_TELEGRAM_CHAT_ID,
    journal: githubJournal({ token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY }) });
  console.log('Тестовый результат отправлен в закрытую группу.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
