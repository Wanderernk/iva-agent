/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// `iva jobs ack <name>` (T20 п.3): закрывает последний провал имени, пустой ack честно
// говорит, что закрывать нечего, без имени — usage.
import assert from "node:assert/strict";
import test from "node:test";

import { createJobsCommand } from "./jobs.ts";

function harness(closed: number) {
  const calls: { file: string; name: string }[] = [];
  const ok: string[] = [];
  const bad: string[] = [];
  const runtime = {
    ENV_PATH: "/tmp/t20-cli-jobs/.env",
    ok: (message: string) => ok.push(message),
    bad: (message: string) => bad.push(message),
    dataDirAbs: () => "/tmp/t20-cli-jobs/data",
  };
  const cmd = createJobsCommand(runtime as never, {
    ack: (file, name) => {
      calls.push({ file, name });
      return Promise.resolve(closed);
    },
    readEnv: () => Promise.resolve({}),
  });
  return { cmd, calls, ok, bad };
}

test("ack закрывает провал имени в таблице фактов", async () => {
  const { cmd, calls, ok, bad } = harness(1);
  await cmd(["ack", "memory-daily"]);
  assert.deepEqual(calls, [
    { file: "/tmp/t20-cli-jobs/data/jobs.json", name: "memory-daily" },
  ]);
  assert.deepEqual(bad, []);
  assert.match(ok[0] ?? "", /memory-daily/u);
});

test("ack без открытого провала говорит об этом", async () => {
  const { cmd, ok, bad } = harness(0);
  await cmd(["ack", "digest"]);
  assert.deepEqual(ok, []);
  assert.match(bad[0] ?? "", /no open failure/u);
});

test("без подкоманды и имени — usage", async () => {
  const { cmd } = harness(0);
  await assert.rejects(cmd([]), /usage: iva jobs ack/u);
  await assert.rejects(cmd(["ack"]), /usage: iva jobs ack/u);
  await assert.rejects(cmd(["list"]), /usage: iva jobs ack/u);
});
