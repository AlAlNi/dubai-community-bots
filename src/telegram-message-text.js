// Telegram RichMessage/RichText: https://core.telegram.org/bots/api#richmessage
// Read visible text only. Never fetch links or interpret message content as code.
export function telegramMessageText(message) {
  if (typeof message?.text === 'string') {
    return message.text.trim() && message.text.length <= 4096 ? message.text : undefined;
  }
  if (!Array.isArray(message?.rich_message?.blocks)) return undefined;
  let nodes = 0, characters = 0;
  const parts = [];
  const wrappers = new Set(['bold', 'italic', 'underline', 'strikethrough', 'spoiler',
    'date_time', 'text_mention', 'subscript', 'superscript', 'marked', 'code', 'url',
    'email_address', 'phone_number', 'bank_card_number', 'ton_address', 'mention',
    'hashtag', 'cashtag', 'bot_command', 'anchor_link', 'reference', 'reference_link']);
  function visit(depth) {
    if (++nodes > 2000 || depth > 24) throw new Error('limit');
  }
  function append(text) {
    if (typeof text !== 'string' || (characters += text.length) > 16384) throw new Error('text');
    parts.push(text);
  }
  function richText(value, depth) {
    visit(depth);
    if (typeof value === 'string') return append(value);
    if (Array.isArray(value)) return value.forEach(item => richText(item, depth + 1));
    if (wrappers.has(value?.type)) return richText(value.text, depth + 1);
    if (value?.type === 'custom_emoji') return append(value.alternative_text);
    if (value?.type === 'mathematical_expression') return append(value.expression);
    throw new Error('unsupported text');
  }
  function blocks(values, depth) {
    visit(depth);
    if (!Array.isArray(values)) throw new Error('blocks');
    for (const block of values) {
      visit(depth + 1);
      if (['paragraph', 'heading', 'pre', 'footer', 'expandable_blockquote', 'pullquote'].includes(block?.type)) {
        richText(block.text, depth + 2);
        if (block.credit !== undefined) { append('\n'); richText(block.credit, depth + 2); }
      } else if (block?.type === 'list') {
        if (!Array.isArray(block.items)) throw new Error('items');
        for (const item of block.items) {
          visit(depth + 2);
          append('- ');
          blocks(item?.blocks, depth + 3);
        }
      } else if (block?.type === 'blockquote' || block?.type === 'details') {
        if (block.type === 'details') { richText(block.summary, depth + 2); append('\n'); }
        blocks(block.blocks, depth + 2);
        if (block.credit !== undefined) richText(block.credit, depth + 2);
      } else if (block?.type !== 'divider' && block?.type !== 'anchor') {
        // Reject unsupported content as a whole, rather than reply to a partial reading.
        throw new Error('unsupported block');
      }
      append('\n');
    }
  }
  try {
    blocks(message.rich_message.blocks, 0);
    return parts.join('').trim() || undefined;
  } catch { return undefined; }
}
