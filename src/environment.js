import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function selectEnvironment(name = 'test', demo = false) {
  const environments = JSON.parse(await readFile(new URL('../config/environments.json', import.meta.url), 'utf8'));
  if (!['test', 'production'].includes(name)) throw new Error('Окружение должно быть test или production');
  if (demo && name === 'production') throw new Error('Демо разрешено только в test');
  const settings = environments[name];
  // Until a transport is implemented, configuration cannot enable delivery.
  if (settings.delivery_enabled !== false) throw new Error('Отправка в Telegram пока не реализована');
  return { ...settings, name, defaultOutput: resolve(settings.data_directory, demo ? 'demo-report.json' : 'report.json') };
}

export function checkReportEnvironment(report, environment, demo) {
  if (report.version !== 1 || report.environment !== environment
      || report.demo !== demo || !Array.isArray(report.drafts)) {
    throw new Error('Отчёт принадлежит другому окружению или формату; выберите другой --output');
  }
}
