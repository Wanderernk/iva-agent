// Сообщение о падении хода. У terminal-сбоя eve присылает и turn.failed, и
// session.failed — оба несут одну и ту же беду, но пользователь должен увидеть её
// один раз. Заявка на уведомление берётся по сессии и ходу и живёт TTL; не ушедшее
// сообщение освобождает заявку, чтобы следующее событие всё-таки объяснило сбой.
//
// Это служебная реплика канала, а не текст модели: мимо Outbox, но не мимо гейта —
// текст провайдера и errorId здесь runtime-контент. Отправку модуль поэтому просит
// брендованную (NoticeSend): гейт стоит на вызове Bot API, а не тут (правило в outbox.ts).
import { humanizeProviderError } from "./error-humanizer.ts";
import { tr } from "./i18n.ts";
import type { NoticeSend } from "./outbox.ts";

export type TelegramFailureData = { message: string; details?: unknown };

type FailureNotice = { turnId: string | null; notifiedAt: number };

const FAILURE_NOTIFICATION_TTL_MS = 60_000;
const failureNotifications = new Map<string, FailureNotice>();

function pruneFailureNotifications(now: number): void {
  for (const [sessionId, notice] of failureNotifications) {
    if (now - notice.notifiedAt >= FAILURE_NOTIFICATION_TTL_MS) {
      failureNotifications.delete(sessionId);
    }
  }
}

function claimFailureNotification(
  sessionId: string,
  turnId: string | null,
  now: number,
): number | null {
  pruneFailureNotifications(now);
  const previous = failureNotifications.get(sessionId);
  if (
    previous !== undefined &&
    now - previous.notifiedAt < FAILURE_NOTIFICATION_TTL_MS &&
    (previous.turnId === null || turnId === null || turnId === previous.turnId)
  ) {
    return null;
  }
  failureNotifications.set(sessionId, { turnId, notifiedAt: now });
  return now;
}

function releaseFailureNotification(sessionId: string, claim: number): void {
  if (failureNotifications.get(sessionId)?.notifiedAt === claim) {
    failureNotifications.delete(sessionId);
  }
}

function extractFailureErrorId(details: unknown): string | undefined {
  if (
    typeof details !== "object" ||
    details === null ||
    Array.isArray(details)
  ) {
    return undefined;
  }
  const errorId = (details as Record<string, unknown>).errorId;
  return typeof errorId === "string" && errorId.length > 0
    ? errorId
    : undefined;
}

export function telegramFailureMessage(data: TelegramFailureData): string {
  const text = humanizeProviderError(data);
  const errorId = extractFailureErrorId(data.details);
  return [
    tr(text.en, text.ru),
    ...(errorId ? ["", `Error id: ${errorId}`] : []),
  ].join("\n");
}

// Отправляет объяснение сбоя ровно один раз на ход: turn.failed и следующий за ним
// session.failed того же сбоя несут один ход (либо null), а второй упавший ход той же
// сессии получает своё уведомление. Сбой самой отправки глотаем: сообщение об ошибке
// не повод рушить обработчик события.
export async function notifyTelegramFailure(
  sessionId: string,
  turnId: string | null,
  data: TelegramFailureData,
  send: NoticeSend,
  { now = Date.now() }: { now?: number } = {},
): Promise<void> {
  if (turnId === "") {
    console.error(
      `[telegram] turn.failed без turnId, сессия ${sessionId}: уведомление считаю по сессии`,
    );
  }
  const claim = claimFailureNotification(
    sessionId,
    turnId === "" ? null : turnId,
    now,
  );
  if (claim === null) return;
  try {
    await send(telegramFailureMessage(data));
  } catch (error) {
    releaseFailureNotification(sessionId, claim);
    console.error(
      `[telegram] не смог отправить уведомление о сбое хода: ${String(error)}`,
    );
  }
}
