// Контракт срабатывания: две ветки — отправка текста и пробуждение агента — идут
// одновременно и не зависят друг от друга, а факт оседает в той же строке. Здесь оба шва
// (send и ход) — двойники: сети и eve в тесте нет.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach } from "node:test";

const root = mkdtempSync(join(tmpdir(), "iva-reminder-fire-"));
process.env.ASSISTANT_DATA_DIR = join(root, "data");
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });

const { add, list, reminderFile } = await import("#lib/reminder-store.ts");
const { runReminderFire } = await import("./fire.ts");

let caseDir = "";
beforeEach(() => {
  caseDir = mkdtempSync(join(root, "case-"));
  process.env.ASSISTANT_DATA_DIR = caseDir;
});
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const NOW = 1_800_000_000_000;

/** Строка уже сработала: тик перевёл её в fired и запустил ребёнка. */
async function firedRow(id = "r1"): Promise<void> {
  await add({
    id,
    text: "позвонить в клинику",
    schedule: { kind: "at", atMs: NOW },
  });
  const { fireDue } = await import("#lib/reminder-store.ts");
  await fireDue(NOW, 10);
  void reminderFile;
}

type SendCall = {
  readonly bot: string;
  readonly chat: string;
  readonly text: string;
  readonly threadId?: string;
};
type SendAck = { ok: boolean; fellBack: boolean; error: string };

function makeSend(script: readonly SendAck[] = []) {
  const calls: SendCall[] = [];
  const send = (
    bot: string,
    chat: string,
    md: unknown,
    options?: { readonly threadId?: string },
  ): Promise<SendAck> => {
    calls.push({ bot, chat, text: String(md), threadId: options?.threadId });
    return Promise.resolve(
      script[calls.length - 1] ?? { ok: true, fellBack: false, error: "" },
    );
  };
  return { calls, send };
}

const turn = (status: "completed" | "failed", message?: string) => () =>
  Promise.resolve({
    status,
    ...(message === undefined ? {} : { message }),
    feedback: () => Promise.resolve(undefined),
  });

const deps = (over: Record<string, unknown> = {}) => ({
  env: {
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_DIGEST_CHAT_ID: "555",
    ASSISTANT_BEARER: "test-bearer",
  } as NodeJS.ProcessEnv,
  chat: () => "555",
  translator: () => Promise.resolve((english: string) => english),
  log: () => {},
  ...over,
});

void test("обе ветки отработали: текст ушёл, агент разбужен, факт в строке", async () => {
  await firedRow();
  const { calls, send } = makeSend();
  const prompts: string[] = [];
  const runTurn = (prompt: string) => {
    prompts.push(prompt);
    return Promise.resolve({
      status: "completed" as const,
      message: "",
      feedback: () => Promise.resolve(undefined),
    });
  };

  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);

  assert.equal(calls.length, 1, "текст ушёл ровно один раз");
  assert.equal(calls[0].chat, "555");
  assert.equal(calls[0].text, "позвонить в клинику");
  assert.equal(prompts.length, 1, "ход разбужен");
  assert.match(prompts[0], /r1/u);
  assert.match(prompts[0], /позвонить в клинику/u);
  assert.match(prompts[0], /remind \{action: "list"\}/u);

  const [row] = await list();
  assert.equal(row?.delivered, true);
  assert.equal(row?.error, null);
  assert.equal(row?.status, "fired");
});

void test("напоминание из темы группы возвращается в ту же тему, а не в чат владельца", async () => {
  await add({
    id: "t1",
    text: "узнать задачи",
    chat: { id: "-100777", threadId: "835397" },
    schedule: { kind: "at", atMs: NOW },
  });
  const { fireDue } = await import("#lib/reminder-store.ts");
  await fireDue(NOW, 10);
  const { calls, send } = makeSend();

  assert.equal(
    await runReminderFire("t1", deps({ send, runTurn: turn("completed", "") })),
    0,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].chat, "-100777");
  assert.equal(calls[0].threadId, "835397");
  const [row] = await list();
  assert.equal(row?.delivered, true);
});

void test("отправка упала: delivered=false с причиной, агент всё равно разбужен", async () => {
  await firedRow();
  const { calls, send } = makeSend([
    { ok: false, fellBack: false, error: "400 chat not found" },
  ]);
  const prompts: string[] = [];
  const runTurn = (prompt: string) => {
    prompts.push(prompt);
    return Promise.resolve({
      status: "completed" as const,
      message: "",
      feedback: () => Promise.resolve(undefined),
    });
  };

  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);

  const [row] = await list();
  assert.equal(row?.delivered, false);
  assert.equal(row?.error, "400 chat not found");
  assert.equal(
    prompts.length,
    1,
    "ветка агента не зависит от провала отправки",
  );
  assert.match(prompts[0], /r1/u);
  assert.equal(calls.length, 1, "вторая ветка сама ничего не шлёт");
});

void test("пробуждение упало: текст ушёл, причина пробуждения записана", async () => {
  await firedRow();
  const { calls, send } = makeSend();

  assert.equal(
    await runReminderFire(
      "r1",
      deps({
        send,
        runTurn: () => Promise.reject(new Error("no activity for 30000ms")),
      }),
    ),
    0,
  );

  const [row] = await list();
  assert.equal(row?.delivered, true, "падение хода не отменяет отправку");
  assert.match(String(row?.error), /agent wake failed: no activity/u);
  assert.equal(calls.length, 1);
});

void test("оба шва сломаны: строка всё равно получает оба факта", async () => {
  await firedRow();
  const { send } = makeSend([
    { ok: false, fellBack: false, error: "403 bot blocked" },
  ]);

  assert.equal(
    await runReminderFire(
      "r1",
      deps({
        send,
        runTurn: () =>
          Promise.resolve({
            status: "failed" as const,
            message: "turn timed out",
            feedback: () => Promise.resolve(undefined),
          }),
      }),
    ),
    0,
  );

  const [row] = await list();
  assert.equal(row?.delivered, false);
  assert.equal(row?.error, "403 bot blocked");
});

void test("ветки стартуют одновременно: ход вызван, пока отправка ещё висит", async () => {
  await firedRow();
  let sendResolved = false;
  let wakeStartedBeforeSend = false;
  const send = async (): Promise<SendAck> => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    sendResolved = true;
    return { ok: true, fellBack: false, error: "" };
  };
  const runTurn = () => {
    wakeStartedBeforeSend = !sendResolved;
    return Promise.resolve({
      status: "completed" as const,
      message: "",
      feedback: () => Promise.resolve(undefined),
    });
  };

  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);
  assert.equal(
    wakeStartedBeforeSend,
    true,
    "ход должен начаться, не дожидаясь отправки",
  );
});

void test("текст не дошёл — агент говорит сам и его сообщение уходит", async () => {
  await firedRow();
  const { calls, send } = makeSend([
    { ok: false, fellBack: false, error: "400 chat not found" },
    { ok: true, fellBack: false, error: "" },
  ]);
  const runTurn = turn(
    "completed",
    "Не смогла отправить напоминание: 400 chat not found",
  );

  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);

  assert.equal(calls.length, 2, "второе сообщение — слово агента");
  assert.equal(
    calls[1].text,
    "Не смогла отправить напоминание: 400 chat not found",
  );
  const [row] = await list();
  assert.equal(row?.delivered, false, "факт кода остаётся провалом доставки");
});

void test("текст дошёл — слово агента владельцу не уходит", async () => {
  await firedRow();
  const { calls, send } = makeSend();
  const runTurn = turn("completed", "напоминаю: позвонить в клинику");

  assert.equal(await runReminderFire("r1", deps({ send, runTurn })), 0);
  assert.equal(calls.length, 1, "дубля сообщения нет");
  const [row] = await list();
  assert.equal(row?.delivered, true);
});

void test("вызов без id и с чужим id — отказ без записи", async () => {
  await firedRow();
  const { calls, send } = makeSend();
  assert.equal(await runReminderFire("", deps({ send })), 2);
  assert.equal(await runReminderFire("nope", deps({ send })), 2);
  assert.equal(calls.length, 0);
  const [row] = await list();
  assert.equal(row?.delivered, null, "чужой вызов не тронул строку");
});

void test("строка ушла к новому сроку — резерв молчит, в журнале newer firing owns the message", async () => {
  await firedRow();
  const [real] = await list();
  assert.ok(real);
  const firedAt = real.firedAt;
  assert.ok(firedAt !== null, "строка должна быть сработавшей");
  // Второе чтение видит строку уже с другим сроком: резерв обязан отступить.
  const moved = { ...real, firedAt: firedAt + 600_000, delivered: false };
  let reads = 0;
  const read = (): Promise<(typeof real)[]> => {
    reads += 1;
    return Promise.resolve(reads === 1 ? [real] : [moved]);
  };
  const { calls, send } = makeSend([
    { ok: false, fellBack: false, error: "400 chat not found" },
  ]);
  const logged: string[] = [];
  const runTurn = turn(
    "completed",
    "Не смогла отправить напоминание: 400 chat not found",
  );

  assert.equal(
    await runReminderFire(
      "r1",
      deps({
        send,
        runTurn,
        list: read,
        log: (...args: unknown[]) => {
          logged.push(args.map(String).join(" "));
        },
      }),
    ),
    0,
  );
  assert.equal(calls.length, 1, "резерв не стрелял в чужую строку");
  assert.ok(
    logged.some((line) => line.includes("newer firing owns the message")),
    `нет строки в журнале: ${JSON.stringify(logged)}`,
  );
});
