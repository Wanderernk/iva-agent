// Хаос-прогон ответов TS-мастера установки (scripts/setup/main.ts): тот же дефект,
// что в install.sh, - русские вопросы и строгий разбор английских ответов. Найдено
// 2026-09-13 маршрутом pbt/deepseek-4-4 (раунд 4), слепая проверка подтвердила.
//
// Мастер нельзя импортировать (он сразу запускает диалог), поэтому поведение держит
// общий разбор ответов, а проводка - сверка исходника: мастер обязан звать общий
// разбор, а не сравнивать строки сам.
//
// КРАСНЫЙ тест здесь - находка; продакшн-код не менялся, починка описана в отчёте
// `.scratch/work/reviews/fix-pbt-deepseek-4-4.md`.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SOURCE = readFileSync(
  new URL("./setup/main.ts", import.meta.url),
  "utf8",
);

type Answers = {
  readonly answerToken: (value: string) => string;
  readonly isYesAnswer: (value: string) => boolean;
  readonly menuChoice: (value: string) => number | null;
};

// До правки общего разбора нет: тест называет это первой же проверкой.
const modulePath = fileURLToPath(
  new URL("./setup/answers.ts", import.meta.url),
);
const answers: Answers | null = existsSync(modulePath)
  ? await import("./setup/answers.ts")
  : null;

await test("НАХОДКА R4-3b: мастер setup понимает «да» и «2.» через общий разбор", () => {
  assert.ok(answers, "нет общего разбора ответов: scripts/setup/answers.ts");
  const parsed = answers;

  for (const yes of ["y", "Y", "yes", "YES", "да", "Д", "Да", "да."])
    assert.equal(parsed.isYesAnswer(yes), true, `«${yes}» обязано быть «да»`);
  for (const no of ["n", "no", "нет", "неа", "maybe", ""])
    assert.equal(parsed.isYesAnswer(no), false, `«${no}» обязано быть «нет»`);

  for (const [input, choice] of [
    ["2", 2],
    ["2.", 2],
    ["2)", 2],
    [" 2 ) ", 2],
    ["1.", 1],
    ["ru", null],
    ["", null],
  ] as const)
    assert.equal(parsed.menuChoice(input), choice, `«${input}»`);

  // Проводка: ни одного собственного сравнения ответа у мастера не остаётся.
  assert.match(SOURCE, /isYesAnswer\(/u, "askYesNo не использует общий разбор");
  assert.doesNotMatch(
    SOURCE,
    /startsWith\("y"\)/u,
    'старый startsWith("y") на месте',
  );
  assert.match(
    SOURCE,
    /menuChoice\(langChoice\)/u,
    "langChoice не использует общий разбор",
  );
  assert.match(
    SOURCE,
    /const provChoice = menuChoice\(/u,
    "выбор провайдера не использует общий разбор",
  );
  assert.doesNotMatch(SOURCE, /=== "2" \? "ru"/u, "старое сравнение языка");
  assert.doesNotMatch(
    SOURCE,
    /provChoice === "2"/u,
    "старое сравнение провайдера",
  );
});
