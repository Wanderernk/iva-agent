// Срабатывание одного напоминания:
//   node --env-file-if-exists=.env scripts/reminders/fire.ts <id>
// Запускает её минутный тик (agent/lib/reminder-tick.ts) на строке, которую уже перевёл в
// fired. Две ветки СТАРТУЮТ ОДНОВРЕМЕННО и не зависят друг от друга по провалу:
//   (а) текст владельцу как есть через sendTelegramHtml — работает без модели и её токенов;
//   (б) агент просыпается ходом-проверкой: доставлен ли текст, и если нет — говорит сам.
// Своё сообщение ветка (б) отправляет только после того, как ветка (а) завершилась и факт
// известен: иначе поздний успех Telegram дал бы владельцу два сообщения. Ожидание
// ограничено потолком ребёнка (REMINDER_FIRE_TIMEOUT_MS у тика).
// Обе только дописывают факт в ту же строку (delivered/error), строку не закрывают и ничего
// не повторяют: повторов у напоминаний нет по решению владельца 12.09. Если процесс упал, не
// сказав факта, тик запишет delivered=false с причиной по коду выхода.
//
// Живёт в scripts/, а не в agent/: выталкивание наружу идёт через Telegram и клиента eve
// (scripts/authored-tree-guard.test.ts: agent/ не импортирует scripts/).
// Коды выхода: 0 — обе ветки отработали; 2 — вызов без id или неизвестный id.
import { isEntrypoint } from "../lib/version-layout.ts";
import { notificationChat } from "../lib/notification-chat.ts";
import {
  list,
  recordDelivery,
  recordWakeError,
  type Reminder,
} from "#lib/reminder-store.ts";
import { resolveTimeZone } from "#lib/timezone.ts";
import { formatZoned } from "#lib/zoned-time.ts";
import { noticeTranslator } from "../lib/notice-policy.ts";
import {
  firePrompt,
  reminderClientOptions,
  runReminderTurn,
  type ReminderTurn,
} from "../lib/reminder-turn.ts";
import { sendTelegramHtml } from "../lib/telegram-send.ts";

const USAGE = "usage: fire.ts <reminder id>";

export type ReminderFireDependencies = {
  readonly env?: NodeJS.ProcessEnv;
  readonly list?: typeof list;
  readonly recordDelivery?: typeof recordDelivery;
  readonly recordWakeError?: typeof recordWakeError;
  readonly send?: typeof sendTelegramHtml;
  readonly runTurn?: typeof runReminderTurn;
  readonly chat?: (env: NodeJS.ProcessEnv) => string | null;
  readonly translator?: typeof noticeTranslator;
  readonly log?: (...args: unknown[]) => void;
};

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/**
 * Однo срабатывание. Возвращает код выхода вместо process.exit: так его проверяет тест, а
 * точку входа закрывает нижний `isEntrypoint`.
 */
export async function runReminderFire(
  id: string,
  dependencies: ReminderFireDependencies = {},
): Promise<number> {
  if (id.trim() === "") {
    console.error(USAGE);
    return 2;
  }
  const env = dependencies.env ?? process.env;
  const read = dependencies.list ?? list;
  const record = dependencies.recordDelivery ?? recordDelivery;
  const recordError = dependencies.recordWakeError ?? recordWakeError;
  const send = dependencies.send ?? sendTelegramHtml;
  const log =
    dependencies.log ?? ((...args: unknown[]) => console.log(...args));

  let row: Reminder | undefined;
  try {
    row = (await read()).find((candidate) => candidate.id === id);
  } catch (error) {
    console.error(`reminders: ${id}: ${message(error)}`);
    return 1;
  }
  if (row === undefined) {
    console.error(`reminders: ${id}: unknown id`);
    return 2;
  }

  const tz = resolveTimeZone(env.ASSISTANT_TIMEZONE);
  const token = String(env.TELEGRAM_BOT_TOKEN ?? "").trim();
  // Куда: чат и тема, где напоминание попросили; строка без чата (старая схема, запрос не
  // из Telegram) - чат владельца из настроек, как раньше.
  const fallback = (dependencies.chat ?? notificationChat)(env);
  const target =
    row.chat ?? (fallback ? { id: fallback, threadId: null } : null);
  const chat = target?.id ?? null;
  const threadId = target?.threadId ?? undefined;
  const tr = await (dependencies.translator ?? noticeTranslator)(env);

  /** Итог ветки отправки для ветки агента: ушёл ли текст и записался ли факт. */
  type DeliveryOutcome = {
    readonly delivered: boolean;
    readonly recorded: boolean;
  };
  // Запись факта — отдельная забота: её падение (лок, диск) не валит ветку и не
  // меняет итог отправки, но остаётся видимым в журнале.
  const recordFact = async (outcome: {
    readonly firedAt: number | null;
    readonly delivered: boolean;
    readonly error: string | null;
  }): Promise<boolean> => {
    try {
      await record(id, outcome, { log });
      return true;
    } catch (error) {
      log(`reminders: ${id} delivery fact not recorded: ${message(error)}`);
      return false;
    }
  };

  // Ветка (а): текст владельцу как есть. Не глядит ни на модель, ни на вторую ветку.
  // Итог send отдаёт наружу итогом: запись факта может упасть (лок, диск), а текст
  // при этом уйти — ветка (б) обязана молчать по итогу отправки, а не по таблице.
  const deliver = async (): Promise<DeliveryOutcome> => {
    if (token === "" || chat === null) {
      const reason =
        token === ""
          ? "TELEGRAM_BOT_TOKEN is missing - run: iva config"
          : "no owner chat: set TELEGRAM_DIGEST_CHAT_ID or TELEGRAM_ALLOWED_USER_IDS";
      const recorded = await recordFact({
        firedAt: row.firedAt,
        delivered: false,
        error: reason,
      });
      log(`reminders: ${id} not delivered: ${reason}`);
      return { delivered: false, recorded };
    }
    const result = await send(token, chat, row.text, {
      retryTransient: true,
      threadId,
      trace: { source: "reminder" },
    });
    const recorded = await recordFact({
      firedAt: row.firedAt,
      delivered: result.ok,
      error: result.ok ? null : result.error,
    });
    log(
      result.ok
        ? `reminders: ${id} delivered`
        : `reminders: ${id} not delivered: ${result.error}`,
    );
    return { delivered: result.ok, recorded };
  };

  // Ветка (б): ход агента. Своё сообщение отправляет только тогда, когда факт доставки уже
  // известен и текст не дошёл: иначе агент продублировал бы работу кода.
  const wake = async (
    delivered: Promise<DeliveryOutcome | undefined>,
  ): Promise<void> => {
    let turn: ReminderTurn;
    try {
      turn = await (dependencies.runTurn ?? runReminderTurn)(
        firePrompt(
          {
            id,
            text: row.text,
            scheduledAt: formatZoned(row.firedAt ?? row.nextRunAtMs, tz),
          },
          tr,
        ),
        reminderClientOptions(env),
        { log },
      );
    } catch (error) {
      const reason = `agent wake failed: ${message(error)}`;
      await recordError(id, { firedAt: row.firedAt, error: reason }, { log });
      log(`reminders: ${id} ${reason}`);
      return;
    }
    if (turn.status === "failed") {
      const reason = `agent turn failed: ${turn.message ?? "unknown"}`;
      await recordError(id, { firedAt: row.firedAt, error: reason }, { log });
      log(`reminders: ${id} ${reason}`);
      return;
    }
    const reply = turn.message?.trim() ?? "";
    if (reply === "") {
      log(`reminders: ${id} agent woke, nothing to say`);
      return;
    }
    if (token === "" || chat === null) {
      const reason = "agent message not sent: no bot token or owner chat";
      await recordError(id, { firedAt: row.firedAt, error: reason }, { log });
      log(`reminders: ${id} ${reason}`);
      return;
    }
    // Ждём итога ветки отправки, а не записи факта: текст уже ушёл — молчим,
    // даже если факт не записался. Падение ветки не валит агента — ветки независимы.
    const outcome = await delivered.catch(() => undefined);
    if (outcome?.delivered === true) {
      log(
        `reminders: ${id} agent woke, text already sent` +
          (outcome.recorded ? "" : " (fact not recorded)"),
      );
      return;
    }
    const after = (await read()).find((candidate) => candidate.id === id);
    // Тот же фенс, что у записи: судим только факт своего срабатывания. Если строка
    // уже ушла к новому сроку, уведомлением владеет его ветка — поздний резерв сюда
    // стрелять не должен, иначе владелец получит дубль к свежему сообщению.
    if (after?.firedAt !== row.firedAt) {
      log(
        `reminders: ${id} agent woke, row moved to firedAt=${after?.firedAt} — newer firing owns the message`,
      );
      return;
    }
    if (after.delivered === true) {
      log(`reminders: ${id} agent woke, text already delivered`);
      return;
    }
    const result = await send(token, chat, reply, {
      retryTransient: true,
      threadId,
      trace: { source: "reminder" },
    });
    if (!result.ok) {
      const reason = `agent message not delivered: ${result.error}`;
      await recordError(id, { firedAt: row.firedAt, error: reason }, { log });
      log(`reminders: ${id} ${reason}`);
      return;
    }
    log(`reminders: ${id} agent sent its own message`);
  };

  const delivered = deliver();
  const woken = wake(delivered);
  const outcomes = await Promise.allSettled([delivered, woken]);
  outcomes.forEach((outcome, index) => {
    if (outcome.status === "rejected")
      log(
        `reminders: ${id} ${index === 0 ? "delivery" : "wake"} branch threw: ${message(outcome.reason)}`,
      );
  });
  return 0;
}

if (isEntrypoint(import.meta.url))
  process.exit(await runReminderFire(process.argv[2] ?? ""));
