// One Reminder turn against the eve client: create a session, read its event stream up to a
// turn boundary, and always reset the session. It lives on the CLI half, not in `agent/`,
// because `iva remind` has to load on an install whose authored tree is missing or
// half-written, and the delivery child process runs the same turn.
import { writtenInLanguage } from "./notice-policy.ts";

export type ReminderClientOptions = {
  readonly host: string;
  readonly auth: { readonly bearer: () => Promise<string> };
};

export function reminderClientOptions(
  env: NodeJS.ProcessEnv,
): ReminderClientOptions {
  const bearer = String(env.ASSISTANT_BEARER ?? "").trim();
  if (!bearer) throw new Error("ASSISTANT_BEARER is missing — run: iva doctor");
  const port = env.IVA_PORT ?? "8723";
  const host = env.ASSISTANT_HOST ?? `http://127.0.0.1:${port}`;
  return { host, auth: { bearer: () => Promise.resolve(bearer) } };
}

export type TurnStreamEvent = {
  readonly type: string;
  readonly data?: unknown;
};

export type ReminderClient = {
  readonly sessions: {
    create(input: { readonly message: string }): Promise<{
      readonly response: AsyncIterable<TurnStreamEvent> & {
        cancel(): Promise<unknown>;
      };
      readonly session: {
        send(message: string): Promise<unknown>;
        reset(options: { readonly reason: string }): Promise<unknown>;
      };
    }>;
  };
};

export type CreateClient = (
  options: ReminderClientOptions,
) => Promise<ReminderClient>;

export type ReminderTurn = {
  readonly status: "completed" | "failed" | "waiting";
  readonly message?: string;
  readonly feedback: (message: string) => Promise<unknown>;
};

export class ReminderTurnError extends Error {}

// Three minutes without a single stream event means the turn is stuck. Eight minutes is the
// ceiling for the whole turn: the delivery child process is killed on its ninth minute.
export const REMINDER_TURN_INACTIVITY_MS = 180_000;
export const REMINDER_TURN_HARD_TIMEOUT_MS = 8 * 60_000;

export function reminderPrompt(
  text: string,
  tr: (en: string, ru: string) => string,
  scheduledAt?: string,
): string {
  const opening =
    scheduledAt === undefined
      ? `A one-time reminder fired: ${JSON.stringify(text)}. `
      : `A reminder set for ${scheduledAt} fired: ${JSON.stringify(text)}. `;
  return (
    opening +
    "Check whether it is still relevant; the task may already be closed, so inspect tasks. " +
    "Formulate a short reminder message for the user and return it as the final text of this turn. " +
    `Return the text ${writtenInLanguage(tr)}. ` +
    "Do not send anything yourself: no rich messages and no Telegram tools. " +
    "Only the finished reminder text, no preamble."
  );
}

/**
 * Промпт пробуждения после срабатывания: агент узнаёт, что код уже отправил текст, и
 * своим ходом закрывает единственный оставшийся случай - текст не дошёл. Решение покоится
 * на факте из строки (delivered/error), поэтому промпт велит сперва посмотреть список.
 */
export function firePrompt(
  fire: {
    readonly id: string;
    readonly text: string;
    readonly scheduledAt: string;
  },
  tr: (en: string, ru: string) => string,
): string {
  return tr(
    `Reminder #${fire.id} fired (text: ${JSON.stringify(fire.text)}, due: ${fire.scheduledAt}). ` +
      'The code is already sending that text to the owner. Check with remind {action: "list"} whether it was delivered. ' +
      "If delivered - do nothing and return an empty answer. " +
      "If it was not delivered - remind the owner yourself: " +
      "write a short message from your own context (look at tasks if that helps) and say that delivery broke and why it did (error from the row). " +
      "Return that message as the final text of this turn; the code will send it. " +
      "Do not send anything yourself: no rich messages and no Telegram tools.",
    `Сработало напоминание #${fire.id} (текст: ${JSON.stringify(fire.text)}, срок: ${fire.scheduledAt}). ` +
      'Код уже отправляет этот текст владельцу. Проверь через remind {action: "list"}, доставлен ли он. ' +
      "Доставлен - ничего не делай и верни пустой ответ. " +
      "Не доставлен - напомни владельцу сама: напиши короткое сообщение по контексту " +
      "(загляни в задачи, если это уместно) и скажи, что доставка сломалась и почему (error из строки). " +
      "Верни это сообщение финальным текстом хода; код отправит его. Сам ничего не отправляй.",
  );
}

type TurnState = {
  readonly status: "completed" | "failed" | "waiting" | undefined;
  readonly message: string | undefined;
  readonly failure: string | undefined;
};

const EMPTY_TURN: TurnState = {
  status: undefined,
  message: undefined,
  failure: undefined,
};

// eve carries the text under `data.message` in message.completed, session.failed and
// turn.failed; anything else changes nothing.
function eventText(event: TurnStreamEvent): string | undefined {
  const data = event.data;
  if (typeof data !== "object" || data === null) return undefined;
  const text = (data as { readonly message?: unknown }).message;
  return typeof text === "string" ? text : undefined;
}

function applyTurnEvent(state: TurnState, event: TurnStreamEvent): TurnState {
  switch (event.type) {
    case "message.completed": {
      const message = eventText(event);
      return message === undefined ? state : { ...state, message };
    }
    case "session.failed": {
      const message = eventText(event);
      return {
        ...state,
        status: "failed",
        ...(message === undefined ? {} : { message }),
      };
    }
    case "session.completed":
      return { ...state, status: "completed" };
    case "session.waiting":
      return { ...state, status: "waiting" };
    case "turn.failed": {
      const failure = eventText(event);
      return failure === undefined ? state : { ...state, failure };
    }
    default:
      return state;
  }
}

/** The boundary status and the last text of an event stream, ignoring anything in between. */
export function reduceTurnEvents(
  events: readonly TurnStreamEvent[],
): TurnState {
  return events.reduce(applyTurnEvent, EMPTY_TURN);
}

type Stall = { readonly stalled: Promise<never>; readonly stop: () => void };

// A stalled turn is a turn with no events: the idle window measures the gap since the last
// event, the cap measures the whole turn, and either one loses the race to the stream.
function stallAfter(ms: number, reason: string): Stall {
  let timer: NodeJS.Timeout | undefined;
  return {
    stalled: new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ReminderTurnError(reason)), ms);
    }),
    stop: () => {
      clearTimeout(timer);
    },
  };
}

async function defaultCreateClient(
  options: ReminderClientOptions,
): Promise<ReminderClient> {
  const { Client } = await import("eve/client");
  return new Client(options);
}

export async function runReminderTurn(
  prompt: string,
  options: ReminderClientOptions,
  deps: {
    readonly createClient?: CreateClient;
    readonly inactivityMs?: number;
    readonly hardTimeoutMs?: number;
    readonly log?: (...args: unknown[]) => void;
  } = {},
): Promise<ReminderTurn> {
  const createClient = deps.createClient ?? defaultCreateClient;
  const inactivityMs = deps.inactivityMs ?? REMINDER_TURN_INACTIVITY_MS;
  const hardTimeoutMs = deps.hardTimeoutMs ?? REMINDER_TURN_HARD_TIMEOUT_MS;
  const log = deps.log ?? console.error;
  const client = await createClient(options);
  let session:
    | Awaited<ReturnType<ReminderClient["sessions"]["create"]>>["session"]
    | undefined;
  try {
    const created = await client.sessions.create({ message: prompt });
    session = created.session;
    let state = EMPTY_TURN;
    const cap = stallAfter(hardTimeoutMs, `turn exceeded ${hardTimeoutMs}ms`);
    try {
      const stream = created.response[Symbol.asyncIterator]();
      for (;;) {
        const idle = stallAfter(
          inactivityMs,
          `no activity for ${inactivityMs}ms`,
        );
        let step: IteratorResult<TurnStreamEvent>;
        try {
          step = await Promise.race([stream.next(), idle.stalled, cap.stalled]);
        } catch (error) {
          if (error instanceof ReminderTurnError) {
            // The turn is stuck: end it at the client before the caller sees the failure.
            try {
              await created.response.cancel();
            } catch (cancelError) {
              log("remind: turn cancel failed:", cancelError);
            }
          }
          throw error;
        } finally {
          idle.stop();
        }
        if (step.done) break;
        state = applyTurnEvent(state, step.value);
      }
    } finally {
      cap.stop();
    }
    if (state.status === undefined) {
      throw new ReminderTurnError("stream ended without a session boundary");
    }
    return {
      status: state.status,
      ...(state.message === undefined ? {} : { message: state.message }),
      feedback: (message) => created.session.send(message),
    };
  } finally {
    if (session) {
      try {
        await session.reset({ reason: "Reminder finished" });
      } catch (error) {
        console.error("remind: session reset failed:", error);
      }
    }
  }
}
