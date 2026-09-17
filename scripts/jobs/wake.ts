// Точка входа пробуждения после запуска расписания:
// `node --env-file-if-exists=.env scripts/jobs/wake.ts <name> <startedAt>`.
// Запускает её schedule-runner (agent/lib/schedule-runner.ts) после каждого запуска.
// Ход агента идёт через тот же шлюз, что у напоминаний (scripts/lib/reminder-turn.ts),
// а ответ уходит владельцу кодом только если он непустой.
import { dataDir } from "#lib/data-dir.ts";
import { jobFactsFile } from "#lib/job-facts.ts";
import { notificationChat } from "../lib/notification-chat.ts";
import { noticeTranslator } from "../lib/notice-policy.ts";
import { runJobWake } from "../lib/job-wake.ts";
import {
  reminderClientOptions,
  runReminderTurn,
} from "../lib/reminder-turn.ts";
import { sendTelegramHtml } from "../lib/telegram-send.ts";

const log = (...args: unknown[]) =>
  console.log(new Date().toISOString(), ...args);

async function main(): Promise<void> {
  const name = (process.argv[2] ?? "").trim();
  const startedAt = Number.parseInt(process.argv[3] ?? "", 10);
  if (name === "" || !Number.isSafeInteger(startedAt)) {
    console.error("usage: wake.ts <name> <startedAt>");
    process.exit(2);
  }
  const token = String(process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const chat = notificationChat(process.env);
  const status = await runJobWake(name, startedAt, {
    factsFile: jobFactsFile(dataDir()),
    tr: await noticeTranslator(process.env),
    runTurn: (prompt) =>
      runReminderTurn(prompt, reminderClientOptions(process.env), { log }),
    send: async (text) => {
      if (!token || !chat)
        throw new Error(
          "TELEGRAM_BOT_TOKEN or the owner chat is missing — run: iva doctor",
        );
      const result = await sendTelegramHtml(token, chat, text);
      return result.ok;
    },
  });
  console.log(`wake: ${name} ${status}`);
  process.exit(status === "failed" ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(
    `wake: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
