import { readFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { selectEnvironment } from './environment.js';
import { validateSearch, researchRequest } from './search.js';
import { runSearch } from './search-runner.js';

async function main() {
  const options = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (['--help', '--dry-run'].includes(args[i])) options[args[i]] = true;
    else if (['--query', '--role', '--days', '--env', '--style'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) {
      const name = args[i];
      options[name] = args[++i];
    }
    else throw new Error('Неизвестный параметр или отсутствует его значение');
  }
  if (options['--help']) {
    console.log('node src/search-cli.js --query "Тема о Дубае" [--role guide|events|transport|everyday] [--days 7] [--env test] [--style none|deepseek] [--dry-run]');
    return;
  }
  const environment = await selectEnvironment(options['--env'] ?? 'test');
  if (environment.name !== 'test') throw new Error('Поиск пока доступен только в test');
  const settings = JSON.parse(await readFile(new URL('../config/search.json', import.meta.url), 'utf8'));
  const editorial = JSON.parse(await readFile(new URL('../config/editorial.json', import.meta.url), 'utf8'));
  const query = options['--query'], role = options['--role'] ?? 'guide', days = Number(options['--days'] ?? 7);
  validateSearch(query, role, days, settings);
  const now = new Date().toISOString();
  const style = options['--style'] ?? 'none';
  if (!['none', 'deepseek'].includes(style)) throw new Error('Выберите --style none или deepseek');
  const styleSettings = style === 'deepseek' ? JSON.parse(await readFile(new URL('../config/style.json', import.meta.url), 'utf8')) : null;
  if (options['--dry-run']) {
    console.log(JSON.stringify({ paid_requests: false, environment: 'test', style, request: researchRequest(query, role, days, settings, now) }, null, 2));
    return;
  }
  try { loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Не удалось загрузить локальный .env'); }
  console.log(`Поиск: ${role}, ${days} дней. До 2 запросов поиска/извлечения и ${settings.max_tool_calls} вызовов веб-поиска. Редактор: ${style}; до ${style === 'deepseek' ? 2 * settings.max_materials : 0} дополнительных API-запросов. Telegram отключён.`);
  const result = await runSearch({ query, role, days, settings, editorial, environment, now, apiKey: process.env.TEST_OPENAI_API_KEY,
    style, styleSettings, deepseekKey: process.env.TEST_DEEPSEEK_API_KEY });
  console.log(`Новых черновиков: ${result.report.added}; повторов: ${result.report.duplicates.length}; отклонено: ${result.report.rejected.length}.`);
  console.log(`Черновики: ${result.reportPath}\nИсточники и исследование: ${result.auditPath}`);
  // Draft bodies stay in the artifact, avoiding unnecessary user content in CI logs.
}
main().catch(error => { console.error(`Ошибка: ${error.message}`); process.exitCode = 1; });
