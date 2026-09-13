// Схемы инструментов плагина уходят к модели как есть, а OpenAI (codex) отвергает весь
// запрос, если хоть у одного инструмента в `pattern` стоит lookaround: «Invalid JSON
// schema: regex lookaround is not supported» (пакет t0uchY 13.09.2026, `param: tools`).
// Плагин чужой, провайдер чужой; единственное наше место между ними - этот прокси.
// Здесь из ответа `tools/list` вырезаются только такие `pattern`: остальная схема,
// включая описание поля, остаётся, модель по-прежнему видит, что от неё ждут.

const LOOKAROUND = /\(\?<?[=!]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Убирает `pattern` с lookaround на любой глубине; возвращает число вырезанных. */
function stripLookaround(node: unknown): number {
  if (Array.isArray(node)) {
    let count = 0;
    for (const item of node) count += stripLookaround(item);
    return count;
  }
  if (!isRecord(node)) return 0;
  let count = 0;
  if (typeof node.pattern === "string" && LOOKAROUND.test(node.pattern)) {
    delete node.pattern;
    count++;
  }
  for (const value of Object.values(node)) count += stripLookaround(value);
  return count;
}

/**
 * Ответ `tools/list` без `pattern`, которые провайдер не примет. Любое другое сообщение
 * возвращается как есть, тем же объектом. Никогда не бросает: мусор - не наш, ответ
 * должен дойти до агента в любом случае.
 */
export function withProviderSafeSchemas<T>(
  message: T,
  log: (line: string) => void = () => {},
): T {
  if (!isRecord(message) || !isRecord(message.result)) return message;
  const tools = message.result.tools;
  if (!Array.isArray(tools)) return message;
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    const stripped = stripLookaround(tool.inputSchema);
    if (stripped > 0)
      log(
        `tool ${String(tool.name)}: dropped ${stripped} regex pattern(s) with lookaround, the provider rejects them`,
      );
  }
  return message;
}
