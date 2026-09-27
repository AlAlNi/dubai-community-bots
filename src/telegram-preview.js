const clip = (s, n) => typeof s === 'string' ? s.length > n ? s.slice(0, n) + '… [сокращено]' : s : '';
export function testPreview(report, role) {
  if (report?.version !== 1 || report.environment !== 'test' || report.demo !== false || !Array.isArray(report.drafts)) {
    throw new Error('Для тестового просмотра нужен отчёт test');
  }
  const drafts = report.drafts.filter(d => d.role === role);
  const ready = drafts.filter(d => d.status === 'needs_review');
  const chosen = ready[0] ?? drafts[0];
  const lines = ['ТЕСТ · результат поиска · ' + clip(role, 30),
    `Карточек: ${drafts.length}; допущено к проверке человеком: ${ready.length}; отклонено при извлечении: ${report.rejected?.length ?? 0}.`];
  if (chosen) {
    lines.push(chosen.status === 'needs_review' ? 'Черновик для просмотра.' : 'НЕ ПРОШЛА ПРОВЕРКУ — ниже исходный черновик, в нём могут быть ошибки.');
    const issues = chosen.style?.verdict?.issues ?? [chosen.review_reason ?? ''];
    if (chosen.status !== 'needs_review') lines.push('Причины: ' + clip(issues.join('; '), 500));
    lines.push(clip(chosen.text ?? chosen.original_text ?? 'Текст отсутствует.', 2700));
    if (drafts.length > 1) lines.push('Показана первая карточка; остальные — в артефакте запуска.');
  } else {
    lines.push('Карточек нет. Это не означает, что предложений на рынке нет.');
    const reasons = [...new Set([...(report.rejected ?? []), ...(report.search_diagnostics ?? [])].map(r => r.reason))];
    lines.push(clip(reasons.join('\n') || 'Исследование не дало данных, пригодных для карточки. Подробности — в артефакте запуска.', 1500));
  }
  return lines.join('\n\n');
}
