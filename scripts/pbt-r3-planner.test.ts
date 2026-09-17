/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Хаос-прогон субагента planner: мусор в аргументах и в плане. Проверено 2026-09-13
// маршрутом pbt/deepseek-4-3 (раунд 3). Находок нет, свойства зелёные: план, не
// совпавший со схемой, до пользователя не доедет, веб-слоты закрыты, sandbox не
// разъезжается с корневым. Это тоже результат: у planner'а нет своего парсера
// аргументов, весь мусор в задаче уходит модели, а структура ответа пинится схемой.

import assert from "node:assert/strict";
import test from "node:test";
import { isDisabledToolSentinel } from "eve/tools";

// Хук резолвинга идёт первым: planner тянет provider по NodeNext-спецификатору.
import "./lib/ts-esm-hooks.ts";

process.env.MODEL_PROVIDER = "ollama";
process.env.OLLAMA_API_KEY = "test-key";

const { default: planner } =
  await import("../agent/subagents/planner/agent.ts");
const { default: plannerSandbox } =
  await import("../agent/subagents/planner/sandbox.ts");
const { default: rootSandbox } = await import("../agent/sandbox.ts");

test("зелёное: мусорный план не проходит схему planner", () => {
  const parse = (value: unknown): boolean =>
    planner.outputSchema.safeParse(value).success;

  assert.equal(
    parse({
      goal: "Цель",
      steps: [{ title: "Шаг", detail: "Деталь", priority: "high" }],
    }),
    true,
  );
  for (const junk of [
    {},
    { goal: "Цель" },
    { goal: "Цель", steps: "не массив" },
    { goal: "Цель", steps: [{ title: "Шаг", detail: "Деталь" }] },
    {
      goal: "Цель",
      steps: [{ title: 1, detail: "Деталь", priority: "high" }],
    },
    {
      goal: "Цель",
      steps: [{ title: "Шаг", detail: "Деталь", priority: "urgent" }],
    },
    { goal: 42, steps: [] },
    null,
    [],
    "план",
  ])
    assert.equal(parse(junk), false, JSON.stringify(junk));
});

test("зелёное: веб-слоты planner закрыты, sandbox тот же, что у корня", async () => {
  for (const name of ["web_fetch", "web_search"]) {
    const { default: slot } = (await import(
      `../agent/subagents/planner/tools/${name}.ts`
    )) as { default: unknown };
    assert.ok(
      isDisabledToolSentinel(slot),
      `planner/${name} обязан оставаться disableTool()`,
    );
  }
  assert.equal(plannerSandbox, rootSandbox);
  assert.ok(planner.description.length > 0);
});
