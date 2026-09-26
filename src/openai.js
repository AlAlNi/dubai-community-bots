export async function createResponse(body, { apiKey, timeoutMs, fetchImpl = fetch }) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Не задан TEST_OPENAI_API_KEY');
  let response;
  try {
    response = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, store: false }),
    });
  } catch {
    throw new Error('Сетевая ошибка или тайм-аут OpenAI. Автоматического повтора нет; запрос мог быть оплачен.');
  }
  // Never echo server error bodies: they can contain fragments of user input.
  if (!response.ok) {
    const explanations = { 401: 'проверьте API-ключ', 403: 'нет доступа', 429: 'лимит запросов или баланс' };
    throw new Error(`OpenAI HTTP ${response.status}: ${explanations[response.status] ?? 'запрос не выполнен'}. Автоматического повтора нет.`);
  }
  let payload;
  try { payload = await response.json(); } catch { throw new Error('OpenAI вернул некорректный JSON'); }
  if (payload.status !== 'completed' || !Array.isArray(payload.output)) throw new Error('Ответ OpenAI не завершён; черновики не создаются');
  return payload;
}

export function responseText(response) {
  const parts = response.output.filter(item => item.type === 'message').flatMap(item => item.content ?? []);
  if (parts.some(part => part.type === 'refusal')) throw new Error('Модель отказалась обрабатывать запрос');
  const value = parts.filter(part => part.type === 'output_text').map(part => part.text).join('\n');
  if (!value.trim()) throw new Error('Модель не вернула текст');
  return value;
}
