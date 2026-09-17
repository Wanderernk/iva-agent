/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Проводка гварда T2 в bash-тул: без этого теста мутация «не вызывать
// schedulerBypassViolation» оставляла весь скоп зелёным - гвард проверялся только сам по
// себе, а не то, что тул его спрашивает ДО exec.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import bash from "../agent/tools/bash.ts";

type BashInput = { command: string; timeoutMs?: number };
type BashResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
};

async function executeBash(input: BashInput): Promise<BashResult> {
  return await (
    bash.execute as unknown as (input: BashInput) => Promise<BashResult>
  )(input);
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

test("bash tool refuses an own timer before it is executed", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "iva-bash-bypass-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Маркер внутри подстановки: если тул всё-таки дойдёт до exec, `touch` создаст файл и
  // тест это увидит. Сам вызов из спеки блокируется первой же командной позицией.
  const marker = join(dir, "executed");
  const result = await executeBash({
    command: `systemd-run --user --on-active=60 iva notify x $(touch ${quote(marker)})`,
    timeoutMs: 1_000,
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /^ЗАБЛОКИРОВАНО:/);
  assert.match(result.stderr, /remind:/);
  assert.equal(result.stdout, "");
  assert.equal(result.timedOut, undefined);
  assert.equal(existsSync(marker), false, "команда не должна была исполниться");
});
