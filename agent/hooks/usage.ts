import { defineHook } from "eve/hooks";
import { resolveModelProvider } from "../lib/model-provider.js";
import { appendUsage, subagentTurnId } from "../lib/usage.js";

// Учёт фактического расхода токенов. ОДИН хук ловит весь расход одного eve-агента без
// двойного счёта: основной Telegram Channel и фоновые джобы через eve/client —
// daily-digest, memory rollup (kind="http"). Шаги субагента (planner) приходят завёрнутыми
// в "subagent.event" → слушаем оба события. Пишем по строке на шаг в data/usage.jsonl;
// читают мост (/usage) и CLI (`iva usage`).
//
// ВАЖНО: в отличие от transcript.ts НЕ фильтруем finishReason="tool-calls" — расход есть на
// КАЖДОМ шаге модели, включая tool-call раунды.

// Модель/провайдер не приходят в событие — используем тот же строгий выбор, что и runtime.
const { name: PROVIDER, model: MODEL } = resolveModelProvider();

interface StepData {
  stepIndex: number;
  turnId: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

/**
 * Одно число расхода: конечное неотрицательное целое. Отсутствующее значение — ноль, как
 * и раньше; всё остальное (1e308, отрицательное, «12», NaN) — `null`, то есть мусор
 * провайдера. Такая строка в лог не пишется: сумма такого числа теряет конечность,
 * `JSON.stringify` пишет Infinity как null, а /usage печатает «0 tokens (in Infinity/out
 * Infinity)» — и лечится это только у источника (PBT-DS1-P F1).
 */
function usageTokens(value: unknown): number | null {
  if (value === undefined || value === null) return 0;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function record(
  data: StepData,
  sessionId: string,
  source: string,
  subagent?: string,
): void {
  const u = data.usage;
  if (!u) return;
  const inT = usageTokens(u.inputTokens);
  const outT = usageTokens(u.outputTokens);
  const cacheRead = usageTokens(u.cacheReadTokens);
  const cacheWrite = usageTokens(u.cacheWriteTokens);
  if (
    inT === null ||
    outT === null ||
    cacheRead === null ||
    cacheWrite === null
  ) {
    // Пропуск не молчаливый: журнал называет шаг и что именно пришло.
    console.error(
      `[usage] расход шага пропущен: turn=${data.turnId ?? "?"} step=${data.stepIndex ?? 0} in=${String(u.inputTokens)} out=${String(u.outputTokens)} cacheRead=${String(u.cacheReadTokens)} cacheWrite=${String(u.cacheWriteTokens)}`,
    );
    return;
  }
  if (inT + outT + cacheRead + cacheWrite === 0) return; // нет usage — не пишем нулевую строку
  appendUsage({
    ts: new Date().toISOString(),
    source,
    provider: PROVIDER,
    model: MODEL,
    sessionId,
    turnId: data.turnId ?? "",
    step: data.stepIndex ?? 0,
    subagent, // undefined для top-level — JSON.stringify его опускает
    in: inT,
    out: outT,
    cacheRead,
    cacheWrite,
    total: inT + outT,
  });
}

export default defineHook({
  events: {
    "step.completed": (event, ctx) => {
      record(event.data, ctx.session.id, ctx.channel.kind ?? "unknown");
    },
    // Шаги инлайн-субагента (planner) — иначе его токены потерялись бы.
    //
    // turnId субагента брать НЕЛЬЗЯ: eve нумерует ходы как turn_<sequence> внутри каждой
    // сессии, у ребёнка счётчик начинается заново, а sessionId мы пишем родительский —
    // значит ключ sessionId:turnId столкнулся бы с каким-то ходом родителя (сразу после
    // /new — с его же текущим turn_0, позже — с давним одноимённым). Пишем ход РОДИТЕЛЯ
    // с суффиксом: ключ уникален по построению, а привязка к ходу сохраняется, поэтому
    // расход субагента продолжает попадать в «итого за ход» (отчёт: scripts/lib/usage.ts).
    "subagent.event": (event, ctx) => {
      const inner = event.data.event;
      if (inner.type === "step.completed") {
        record(
          {
            ...inner.data,
            turnId: subagentTurnId(
              ctx.session.turn,
              event.data.subagentName,
              inner.data.turnId,
            ),
          },
          ctx.session.id,
          ctx.channel.kind ?? "unknown",
          event.data.subagentName,
        );
      }
    },
  },
});
