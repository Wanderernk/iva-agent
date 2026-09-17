// Дневной сторож расписаний (T20 п.4) — thin spawner: раз в сутки запускает
// scripts/jobs/watchdog.ts, который сам решает, слать ли владельцу сообщение
// («за сутки N провалов, агент не отвечает; iva doctor»). Запуск оставляет факт, но
// агента о себе не будит: сторож и есть страховка на случай молчащего агента.
import { defineSchedule } from "eve/schedules";
import { resolvePaths } from "../lib/schedule-paths.js";
import { runScheduledJob } from "../lib/schedule-runner.js";
import { SCHEDULE_CRON } from "../lib/schedule-table.js";

export default defineSchedule({
  cron: SCHEDULE_CRON["jobs-watchdog"],
  run({ waitUntil }) {
    const { root, statusPath, factsPath } = resolvePaths();
    waitUntil(
      runScheduledJob({
        name: "jobs-watchdog",
        argv: ["scripts/jobs/watchdog.ts"],
        root,
        nodeBin: process.execPath,
        statusPath,
        factsPath,
        wake: false,
      }),
    );
  },
});
