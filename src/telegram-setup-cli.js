import { appendFile } from 'node:fs/promises';
import { inspectTelegram } from './telegram-setup.js';

try {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/develop') {
    throw new Error('Настройка доступна через GitHub Actions только для develop');
  }
  const result = await inspectTelegram({ token: process.env.TEST_TELEGRAM_HOUSING_BOT_TOKEN });
  const summary = `## Тестовый Telegram\n\nБот: @${result.username}\n\nЗакрытая группа найдена. Сохраните ID в GitHub Actions secret **TEST_TELEGRAM_CHAT_ID**:\n\n\`\`\`text\n${result.chatId}\n\`\`\`\n\nСообщения не отправлялись. Название группы, участники и переписка не сохраняются.\n`;
  await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log('Группа найдена. ID и следующий шаг — в Summary этого запуска.');
} catch (error) {
  // Module errors are sanitized; never print stacks or provider response bodies.
  console.error(error.message);
  process.exitCode = 1;
}
