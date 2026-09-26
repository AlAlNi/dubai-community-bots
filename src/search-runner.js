import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { discover, validateSearch } from './search.js';
import { prepare } from './pipeline.js';
import { polishDraft } from './style.js';
import { checkReportEnvironment } from './environment.js';
import { readJson, withLock, writeJson, writeText } from './storage.js';

export function reserveRun(ledger, now, limit) {
  if (ledger.version !== 1 || !Array.isArray(ledger.runs)) throw new Error('Повреждён журнал запусков');
  const day = new Date(Date.parse(now) + 4 * 3600000).toISOString().slice(0, 10);
  if (ledger.runs.filter(r => r.day === day).length >= limit) throw new Error('Достигнут дневной лимит запусков в этом хранилище');
  const run = { id: randomUUID(), day, started_at: now, status: 'reserved' };
  return { ledger: { ...ledger, runs: [...ledger.runs, run] }, run };
}
export async function runSearch({ query, role, days, settings, editorial, environment, apiKey,
  style = 'none', styleSettings, deepseekKey,
  now = new Date().toISOString(), fetchImpl, directory = resolve(environment.data_directory, 'search') }) {
  if (environment.name !== 'test') throw new Error('Поиск пока доступен только в test');
  validateSearch(query, role, days, settings);
  if (!apiKey?.trim()) throw new Error('Не задан TEST_OPENAI_API_KEY');
  if (!['none', 'deepseek'].includes(style)) throw new Error('Неизвестный редактор');
  if (style === 'deepseek' && (!deepseekKey?.trim() || !styleSettings)) throw new Error('Для редактуры нужен TEST_DEEPSEEK_API_KEY и config/style.json');
  // Validate editorial configuration before any paid request.
  prepare([], editorial, [], now);
  const reportPath = resolve(directory, 'report.json');
  return withLock(reportPath, async () => {
    const previous = await readJson(reportPath, null);
    if (previous) checkReportEnvironment(previous, 'test', false);
    prepare([], editorial, previous?.drafts ?? [], now);
    const ledgerPath = resolve(directory, 'runs.json');
    const reserved = reserveRun(await readJson(ledgerPath, { version: 1, runs: [] }), now, settings.max_runs_per_day);
    await writeJson(ledgerPath, reserved.ledger); // Failed/ambiguous requests also consume a slot.
    const auditPath = resolve(directory, `${reserved.run.id}.json`);
    const audit = { run_id: reserved.run.id, environment: 'test', query, role, days, started_at: now, status: 'started' };
    try {
      await writeJson(auditPath, audit);
      const result = await discover({ query, role, days, settings, now, apiKey, fetchImpl,
        onResearch: async research => { audit.research = research; await writeJson(auditPath, audit); } });
      const fresh = prepare([], editorial, previous?.drafts ?? [], now).drafts;
      const keys = new Set(fresh.filter(d => d.status !== 'expired').map(d => d.material.discovery_key).filter(Boolean));
      const materials = [], duplicates = [];
      for (const item of result.materials) {
        if (keys.has(item.discovery_key)) duplicates.push(item.id);
        else { materials.push(item); keys.add(item.discovery_key); }
      }
      const report = prepare(materials, editorial, fresh, now);
      if (style === 'deepseek') {
        // Only polish newly accepted drafts; older text and review state remain intact.
        for (let i = fresh.length; i < report.drafts.length; i++) {
          report.drafts[i] = await polishDraft(report.drafts[i], {
            settings: styleSettings, deepseekKey, openaiKey: apiKey, fetchImpl,
          });
        }
      }
      report.environment = 'test';
      report.duplicates.push(...duplicates);
      report.rejected.push(...result.rejected);
      report.last_search_run = reserved.run.id;
      audit.extraction = result.extraction;
      audit.materials = result.materials;
      audit.rejected = report.rejected;
      audit.style = report.drafts.slice(fresh.length).map(d => ({ id: d.material.id, ...(d.style ?? { status: 'disabled' }) }));
      audit.status = 'completed';
      await writeJson(auditPath, audit);
      await writeJson(reportPath, report);
      const preview = ['# Черновики для проверки', '', `Подготовлено: ${now}. Отправка в Telegram отключена.`, '',
        ...report.drafts.filter(d => d.status !== 'expired').flatMap(d => [`## ${d.role} — ${d.status}`, '',
          d.review_note ?? 'Требуется проверка редактором.', `Редактура: ${d.style?.status ?? 'disabled'}.`, '', '### Текст поста', '', d.text, '', '---', ''])];
      await writeText(resolve(directory, 'drafts.md'), preview.join('\n'));
      reserved.run.status = 'completed';
      reserved.run.added = report.added;
      await writeJson(ledgerPath, reserved.ledger);
      return { report, reportPath, auditPath };
    } catch (error) {
      reserved.run.status = 'failed';
      audit.status = 'failed';
      // Exceptions are controlled by our modules; no provider response bodies or credentials are persisted.
      audit.error = error.message;
      await writeJson(auditPath, audit);
      await writeJson(ledgerPath, reserved.ledger);
      throw error;
    }
  });
}
