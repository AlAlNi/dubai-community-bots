import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { discover, validateSearch } from './search.js';
import { prepare } from './pipeline.js';
import { polishDraft, checkDraft } from './style.js';
import { checkReportEnvironment } from './environment.js';
import { readJson, withLock, writeJson, writeText } from './storage.js';
import { stayPlan } from './housing.js';

const defaultStyleSettings = JSON.parse(await readFile(new URL('../config/style.json', import.meta.url), 'utf8'));

export function reserveRun(ledger, now, limit) {
  if (ledger.version !== 1 || !Array.isArray(ledger.runs)) throw new Error('Повреждён журнал запусков');
  const day = new Date(Date.parse(now) + 4 * 3600000).toISOString().slice(0, 10);
  if (ledger.runs.filter(r => r.day === day).length >= limit) throw new Error('Достигнут дневной лимит запусков в этом хранилище');
  const run = { id: randomUUID(), day, started_at: now, status: 'reserved' };
  return { ledger: { ...ledger, runs: [...ledger.runs, run] }, run };
}
export async function runSearch({ query, role, days, settings, editorial, environment, apiKey,
  style = 'none', styleSettings = defaultStyleSettings, deepseekKey, checkIn,
  now = new Date().toISOString(), fetchImpl, directory = resolve(environment.data_directory, 'search') }) {
  if (environment.name !== 'test') throw new Error('Поиск пока доступен только в test');
  validateSearch(query, role, days, settings);
  if (role === 'housing') stayPlan(checkIn, now);
  else if (checkIn) throw new Error('Дата заезда применяется только к housing');
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
    const audit = { run_id: reserved.run.id, environment: 'test', query, role, days, started_at: now, status: 'started',
      ...(role === 'housing' ? { stay: stayPlan(checkIn, now) } : {}) };
    try {
      await writeJson(auditPath, audit);
      const result = await discover({ query, role, days, settings, now, apiKey, fetchImpl, checkIn,
        onResearch: async research => { audit.research = research; await writeJson(auditPath, audit); } });
      const fresh = prepare([], editorial, previous?.drafts ?? [], now).drafts;
      for (const draft of fresh) {
        if (draft.status !== 'expired' && draft.status !== 'blocked' && draft.style?.verdict?.source_consistent !== true) {
          draft.original_text ??= draft.text;
          draft.text = null;
          draft.status = 'blocked';
          draft.review_reason = 'quality_check_required';
        }
      }
      const keys = new Set(fresh.filter(d => d.status !== 'expired').map(d => d.material.discovery_key).filter(Boolean));
      const materials = [], duplicates = [];
      for (const item of result.materials) {
        if (keys.has(item.discovery_key)) duplicates.push(item.id);
        else { materials.push(item); keys.add(item.discovery_key); }
      }
      const report = prepare(materials, editorial, fresh, now);
      // All new search drafts need a consistency check, even without DeepSeek.
      for (let i = fresh.length; i < report.drafts.length; i++) {
        const check = style === 'deepseek' ? polishDraft : checkDraft;
        report.drafts[i] = await check(report.drafts[i], {
          settings: styleSettings, deepseekKey, openaiKey: apiKey, fetchImpl,
        });
      }
      report.environment = 'test';
      report.duplicates.push(...duplicates);
      report.rejected.push(...result.rejected);
      report.last_search_run = reserved.run.id;
      audit.extraction = result.extraction;
      audit.materials = result.materials;
      if (result.comparisons) {
        report.housing_search = { stay: audit.stay, periods: result.comparisons.map(c => ({
          ...c, status: c.material_id ? report.drafts.find(d => d.material.id === c.material_id && d.status !== 'expired')?.status ?? 'blocked' : c.status,
        })) };
        audit.housing_search = report.housing_search;
      }
      audit.rejected = report.rejected;
      audit.style = report.drafts.slice(fresh.length).map(d => ({ id: d.material.id, ...(d.style ?? { status: 'disabled' }) }));
      audit.status = 'completed';
      await writeJson(auditPath, audit);
      await writeJson(reportPath, report);
      const preview = ['# Черновики для проверки', '', `Подготовлено: ${now}. Отправка в Telegram отключена.`, '',
        ...(report.housing_search ? report.housing_search.periods.map(p => `Жильё ${p.period}: ${p.check_in} — ${p.check_out}, ${p.nights} ночей; сравнимых ${p.count}, информационных ${p.informational_count ?? 0}; ${p.status}.`) : []), '',
        ...report.drafts.filter(d => d.status !== 'expired').flatMap(d => [`## ${d.role} — ${d.status}`, '',
          `ID карточки: ${d.material.id}`, d.review_note ?? 'Требуется проверка редактором.', `Редактура: ${d.style?.status ?? 'disabled'}.`, '',
          ...(d.status === 'blocked' ? [`Заблокировано: ${d.review_reason}. Подробности — в report.json. Исходник не готов к публикации.`]
            : ['### Текст поста', '', d.text]), '', '---', ''])];
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
