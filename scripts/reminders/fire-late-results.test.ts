// Приёмочные тесты слепого QA (qa-t17.md, блокеры 1 и 2), перенесённые в ветку как
// обычные тесты. Блокер 1: поздний успех прямой отправки не даёт второго сообщения —
// ветка агента ждёт завершения ветки отправки, а не гонку на 10 секунд. Блокер 2:
// результат старого срока повторяющегося напоминания не переписывает факт нового.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";

const ROOT = mkdtempSync(join(tmpdir(), "iva-reminder-late-"));
process.env.ASSISTANT_DATA_DIR = join(ROOT, "bootstrap");
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });

const { add, fireDue, list, reminderFile } =
  await import("#lib/reminder-store.ts");
const { acquireLock, releaseLock } = await import("#lib/json-store.ts");
const { runReminderFire } = await import("./fire.ts");

beforeEach(() => {
  process.env.ASSISTANT_DATA_DIR = mkdtempSync(join(ROOT, "case-"));
});
after(() => rmSync(ROOT, { recursive: true, force: true }));

type Ack = { ok: boolean; fellBack: boolean; error: string };

const success = (): Ack => ({ ok: true, fellBack: false, error: "" });
const completed = (message: string) => () =>
  Promise.resolve({
    status: "completed" as const,
    message,
    feedback: () => Promise.resolve(undefined),
  });

const deps = (over: Record<string, unknown>) => ({
  env: {
    TELEGRAM_BOT_TOKEN: "fake-token",
    TELEGRAM_DIGEST_CHAT_ID: "555",
    ASSISTANT_BEARER: "fake-bearer",
  } as NodeJS.ProcessEnv,
  chat: () => "555",
  translator: () => Promise.resolve((english: string) => english),
  log: () => {},
  ...over,
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 1));
}

void test("BLOCKER: late Telegram success must not produce a second reminder message", async () => {
  const now = 1_800_000_000_000;
  await add({
    id: "late-success",
    text: "позвонить в клинику",
    schedule: { kind: "at", atMs: now },
  });
  await fireDue(now, 10);

  let finishOriginal!: (ack: Ack) => void;
  const original = new Promise<Ack>((resolve) => {
    finishOriginal = resolve;
  });
  const sent: string[] = [];
  const send = (_bot: string, _chat: string, text: unknown): Promise<Ack> => {
    sent.push(String(text));
    return sent.length === 1 ? original : Promise.resolve(success());
  };

  const firing = runReminderFire(
    "late-success",
    deps({
      send,
      runTurn: completed("Резервное напоминание от агента"),
      // Двойник убирает 10-секундную паузу гонки: с ней баг воспроизводился бы
      // только через реальные 10 секунд, а проверяем мы исход.
      sleep: () => Promise.resolve(),
    }),
  );
  await waitFor(() => sent.length === 2);
  finishOriginal(success());
  await firing;

  assert.deepEqual(
    sent,
    ["позвонить в клинику"],
    "поздний успех исходной отправки пришёл после fallback и дал два сообщения",
  );
});

void test("BLOCKER: a late result from the previous Routine occurrence must not overwrite the latest fact", async () => {
  const now = 1_800_000_000_000;
  await add({
    id: "routine",
    text: "проверить отчёт",
    schedule: { kind: "cron", expr: "*/10 * * * *", tz: "UTC" },
    nextRunAtMs: now,
  });
  const [firstOccurrence] = await fireDue(now, 10);
  assert.ok(firstOccurrence);

  let finishFirst!: (ack: Ack) => void;
  const firstAck = new Promise<Ack>((resolve) => {
    finishFirst = resolve;
  });
  let firstStarted = false;
  const firstRun = runReminderFire(
    "routine",
    deps({
      send: () => {
        firstStarted = true;
        return firstAck;
      },
      runTurn: completed(""),
    }),
  );
  await waitFor(() => firstStarted);

  const [secondOccurrence] = await fireDue(firstOccurrence.nextRunAtMs, 10);
  assert.ok(secondOccurrence);
  await runReminderFire(
    "routine",
    deps({ send: () => Promise.resolve(success()), runTurn: completed("") }),
  );
  assert.equal(
    (await list())[0]?.delivered,
    true,
    "второй срок завершился успешно",
  );

  finishFirst({
    ok: false,
    fellBack: false,
    error: "first occurrence failed late",
  });
  await firstRun;
  const [final] = await list();
  assert.equal(final?.firedAt, secondOccurrence.firedAt);
  assert.equal(
    final?.delivered,
    true,
    `старый результат переписал факт нового срока: ${JSON.stringify(final)}`,
  );
  assert.equal(final?.error, null);
});

void test("T34: агентская ветка отступает, когда строка ушла к новому срабатыванию", async () => {
  // Находка 2: ветка судит только факт своего срабатывания (тот же фенс firedAt,
  // что у записи). Пока строка ушла к N+1, поздний резерв N обязан молчать —
  // иначе владелец получает дубль к свежему уведомлению.
  const now = 1_800_000_000_000;
  await add({
    id: "moved-on",
    text: "проверить отчёт",
    schedule: { kind: "cron", expr: "*/10 * * * *", tz: "UTC" },
    nextRunAtMs: now,
  });
  const [first] = await fireDue(now, 10);
  assert.ok(first);

  let releaseSend!: (ack: Ack) => void;
  const gate = new Promise<Ack>((resolve) => {
    releaseSend = resolve;
  });
  const sent: string[] = [];
  let calls = 0;
  const send = (_bot: string, _chat: string, text: unknown): Promise<Ack> => {
    calls += 1;
    sent.push(String(text));
    return calls === 1 ? gate : Promise.resolve(success());
  };

  const firing = runReminderFire(
    "moved-on",
    deps({
      send,
      runTurn: completed("Агентское резервное сообщение"),
    }),
  );
  await waitFor(() => calls === 1);
  // Строка уходит к N+1, пока резерв N ещё решает: факт уже не его.
  const [second] = await fireDue(first.nextRunAtMs, 10);
  assert.ok(second);
  assert.notEqual(second.firedAt, first.firedAt);
  releaseSend(success());
  await firing;

  assert.deepEqual(
    sent,
    ["проверить отчёт"],
    "резерв старого срабатывания выстрелил в строку нового срока",
  );
});

void test("T34b-v2: упавшая запись факта не даёт второго сообщения", async () => {
  // Репро критика без подмен стора: лок таблицы держит сосед — recordDelivery
  // падает по таймауту, хотя текст ушёл. Ветка доставки отдаёт итог send наружу,
  // и резерв молчит: судить о доставке по null в таблице больше нельзя.
  const now = 1_800_000_000_000;
  await add({
    id: "locked-fact",
    text: "забрать посылку",
    schedule: { kind: "at", atMs: now },
  });
  await fireDue(now, 10);

  const lockPath = `${reminderFile()}.lock`;
  let token: string | null = null;
  const sent: string[] = [];
  try {
    await runReminderFire(
      "locked-fact",
      deps({
        send: (_bot: string, _chat: string, text: unknown): Promise<Ack> => {
          sent.push(String(text));
          if (String(text) === "забрать посылку")
            return acquireLock(lockPath).then((held) => {
              token = held;
              return success();
            });
          return Promise.resolve(success());
        },
        runTurn: completed("текст не дошёл, напоминаю: забрать посылку"),
      }),
    );
  } finally {
    if (token) releaseLock(lockPath, token);
  }
  assert.deepEqual(sent, ["забрать посылку"], `дубль: ${JSON.stringify(sent)}`);
});

void test("T35: проснувшийся агент молчит, когда строка ушла к новому срабатыванию", async () => {
  // Находка 2 из T35: фенс по firedAt в агентской ветке (fire.ts ~:202) не держал
  // ни один тест. Строка уходит к N+1, пока доставка N ещё решает; резерв N обязан
  // молчать и назвать причину в журнале, а не выстрелить в чужой срок.
  const now = 1_800_000_000_000;
  await add({
    id: "moved-on-late",
    text: "проверить отчёт",
    schedule: { kind: "cron", expr: "*/10 * * * *", tz: "UTC" },
    nextRunAtMs: now,
  });
  const [first] = await fireDue(now, 10);
  assert.ok(first);

  let releaseSend!: (ack: Ack) => void;
  const gate = new Promise<Ack>((resolve) => {
    releaseSend = resolve;
  });
  const sent: string[] = [];
  let calls = 0;
  const send = (_bot: string, _chat: string, text: unknown): Promise<Ack> => {
    calls += 1;
    sent.push(String(text));
    return calls === 1 ? gate : Promise.resolve(success());
  };
  const lines: string[] = [];
  const log = (...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(" "));
  };

  const firing = runReminderFire(
    "moved-on-late",
    deps({
      send,
      runTurn: completed("Агентское резервное сообщение"),
      log,
    }),
  );
  await waitFor(() => calls === 1);
  // Строка уходит к N+1, пока ветка доставки N не отдала итог.
  const [second] = await fireDue(first.nextRunAtMs, 10);
  assert.ok(second);
  assert.notEqual(second.firedAt, first.firedAt);
  releaseSend({ ok: false, fellBack: false, error: "telegram 500" });
  await firing;

  assert.deepEqual(
    sent,
    ["проверить отчёт"],
    `резерв старого срока выстрелил в строку нового: ${JSON.stringify(sent)}`,
  );
  assert.ok(
    lines.some((line) =>
      line.includes(`row moved to firedAt=${second.firedAt}`),
    ),
    `журнал не назвал причину: ${lines.join(" | ")}`,
  );
});
