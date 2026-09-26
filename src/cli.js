import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { prepare } from './pipeline.js';
import { selectEnvironment, checkReportEnvironment } from './environment.js';

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--demo' || arg === '--help') options[arg] = true;
    else if (['--input', '--output', '--config', '--env'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) options[arg] = args[++i];
    else throw new Error(`Неизвестный параметр или отсутствует значение: ${arg}`);
  }
  if (options['--help']) {
    console.log('node src/cli.js --demo | --input materials.json [--env test|production] [--output path] [--config config/editorial.json]');
    return;
  }
  if (options['--demo'] && options['--input']) throw new Error('Выберите --demo или --input');
  if (!options['--demo'] && !options['--input']) throw new Error('Укажите --demo или --input materials.json');
  const demo = Boolean(options['--demo']);
  const environment = await selectEnvironment(options['--env'] ?? 'test', demo);
  const input = resolve(options['--input'] ?? 'examples/materials.json');
  const output = resolve(options['--output'] ?? environment.defaultOutput);
  const configPath = resolve(options['--config'] ?? 'config/editorial.json');
  if ([input, configPath].includes(output)) throw new Error('Выходной файл не должен совпадать с входным или конфигурацией');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const items = JSON.parse(await readFile(input, 'utf8'));
  await mkdir(dirname(output), { recursive: true });
  const lockPath = `${output}.lock`;
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Файл занят другим запуском: ${lockPath}`);
    throw error;
  }
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    let previous = [];
    try {
      const report = JSON.parse(await readFile(output, 'utf8'));
      checkReportEnvironment(report, environment.name, demo);
      previous = report.drafts;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Fixed time keeps the fictional fixture reproducible on any launch date.
    const now = demo ? '2026-09-26T08:00:00+04:00' : new Date().toISOString();
    const report = prepare(items, config, previous, now, demo);
    report.environment = environment.name;
    const file = await open(temporary, 'wx');
    try { await file.writeFile(JSON.stringify(report, null, 2) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, output);
    console.log(`Добавлено: ${report.added}. Повторов: ${report.duplicates.length}. Отклонено: ${report.rejected.length}.`);
    console.log(`Окружение: ${environment.name}. Отчёт: ${output}`);
    for (const draft of report.drafts.filter(d => d.status !== 'expired')) console.log(`\n--- ${draft.status} ---\n${draft.text}`);
    if (report.rejected.length) console.log('\nПричины отклонения:\n' + JSON.stringify(report.rejected, null, 2));
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await lock.close();
    await unlink(lockPath);
  }
}
main().catch(error => { console.error(`Ошибка: ${error.message}`); process.exitCode = 1; });
