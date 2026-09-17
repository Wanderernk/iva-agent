// Iva interactive setup: writes .env.
// Step-by-step guide with per-key instructions, live validation, and a loop —
// the script will NOT exit until every required secret is entered.
// No external dependencies.
import { createInterface } from "node:readline/promises";
import { createReadStream, existsSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  confirmOccupiedCurrentPort,
  defaultChecker,
  PortSelector,
} from "../lib/ports.ts";
import {
  generateAssistantBearer,
  isAssistantBearer,
} from "../lib/assistant-auth.ts";
import {
  envValueRejection,
  formatEnvLine,
  parseEnvText,
  writeEnvAtomicSync,
} from "../lib/env-file.ts";
import {
  authFilePath,
  readAuth,
  runDeviceCodeLogin,
  runBrowserLogin,
  listCodexModels,
} from "../lib/codex-oauth.ts";
import {
  probeOpenRouterModel,
  validateModelSelection,
} from "../lib/model-validation.ts";
import {
  catalogProvider,
  fetchModels,
  providerBase,
  providerEnvKeys,
} from "../lib/model-catalog.ts";
import { keptSetupWritePlan } from "../lib/setup-keep.ts";
import { isEntrypoint } from "../lib/version-layout.ts";
import { isYesAnswer, menuChoice } from "./answers.ts";
import { resolveDataDir } from "../lib/data-dir.ts";
import { openrouterErrReason } from "./openrouter.ts";
import {
  askKeysSettings,
  askProviderSettings,
  askTelegramSettings,
  askVaultAndPort,
  C,
  writeSetupEnv,
  type AskRequiredOptions,
  type Env,
  type SetupContext,
  type TelegramBot,
  type TelegramUser,
  type ThrownSetupError,
} from "./steps.ts";

// These response types document the happy path without changing the former
// JavaScript property-access behaviour for malformed provider responses.
type ModelListResponse = { data?: Array<{ id: string }> };
type TelegramGetMeResponse = {
  ok?: boolean;
  description?: string;
  result?: TelegramBot;
};
type TelegramFrom = {
  id: string | number;
  first_name?: string;
  last_name?: string;
  username?: string;
};
type TelegramMessage = { from?: TelegramFrom };
type TelegramUpdate = {
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};
type TelegramUpdatesResponse = {
  ok?: boolean;
  description?: string;
  result?: TelegramUpdate[];
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
// The configuration this run starts from. Normally the live .env of the installation;
// `IVA_CONFIG_INPUT` points it elsewhere, which is what lets the wizard be run against a
// fixture instead of the machine's own configuration - the reason its "already configured"
// branch went untested until it shipped a bug (issue #161). Symmetric with the output side
// below, and the two are independent: reading a fixture does not decide where it writes.
const SOURCE_ENV_PATH = process.env.IVA_CONFIG_INPUT
  ? resolve(process.env.IVA_CONFIG_INPUT)
  : join(ROOT, ".env");
// `iva config` stages a complete candidate outside the live .env, then applies it
// transactionally. Direct setup/install keeps the historical live path.
const ENV_PATH = process.env.IVA_CONFIG_OUTPUT
  ? resolve(process.env.IVA_CONFIG_OUTPUT)
  : SOURCE_ENV_PATH;
const STAGING_CONFIG = ENV_PATH !== SOURCE_ENV_PATH;
// Абсолютный каталог data (тот же, что видит агент из cwd=ROOT). Хранит codex-auth.json (OAuth).
const dataDirAbs = (env: Env | null | undefined) => {
  return resolveDataDir(ROOT, env?.ASSISTANT_DATA_DIR);
};
const OLLAMA_BASE = "https://ollama.com/v1";
const OPENCODE_BASE = "https://opencode.ai/zen/go/v1";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
// OpenCode Go (ex-Zen; the /zen/ API path is legacy and still the live one) — bare model ID
// without the "opencode-go/" prefix: that's exactly what the /v1 endpoint expects in the request
// body (with the prefix it answers "Model ... is not supported"). The wizard fetches the live
// list from GET /models; this is only the offline fallback.
const OPENCODE_MODELS = [
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "deepseek-v4.1-flash",
  "kimi-k3",
  "kimi-k2.7-code",
  "glm-5.2",
  "minimax-m3",
  "qwen3.7-max",
  "grok-4.5",
];

const TOTAL = 5;

// UI language (en|ru) — also becomes the agent's default reply language (AGENT_LANGUAGE).
// Set in main() once the choice is known; helpers below read it.
let LANG = "ru";
const t = (en: string, ru: string) => (LANG === "en" ? en : ru);
const KEEP = () => t("…(keep)", "…(оставить)");

// Read from tty even when launched via `curl | bash`: there stdin is the script itself,
// so the answers have to come from the terminal. Where there is no controlling terminal
// at all (a plain spawn without a pty), opening /dev/tty fails with ENXIO and used to kill
// the wizard on an unhandled error event - read whatever stdin is instead. Opened with
// openSync, because a createReadStream failure arrives asynchronously and cannot be caught
// here.
function promptInput(): NodeJS.ReadableStream {
  if (process.stdin.isTTY) return process.stdin;
  try {
    return createReadStream("", { fd: openSync("/dev/tty", "r") });
  } catch {
    return process.stdin;
  }
}
const rl = createInterface({ input: promptInput(), output: process.stdout });

// Почему `.env` не примет это значение, словами владельца - или null.
const envComplaint = (value: string): string | null => {
  const rejection = envValueRejection(value);
  if (!rejection) return null;
  const problem = {
    newline: t("a line break", "перенос строки"),
    control: t(
      "a hidden control character (check the paste)",
      "невидимый управляющий символ (проверьте вставку)",
    ),
    "non-ascii": t(
      "a character outside the Latin alphabet",
      "символ вне латиницы",
    ),
    special: t("one of # \" ' ` \\", "один из знаков # \" ' ` \\"),
    "edge-space": t(
      "a space at the start or end",
      "пробел в начале или в конце",
    ),
  }[rejection];
  return t(
    `The value has ${problem}. The service and the iva command would read it differently, so .env cannot hold it — enter it without that character.`,
    `В значении ${problem}. Сервис и команда iva прочитали бы его по-разному, поэтому .env такое не хранит — введите значение без этого знака.`,
  );
};

// Один вопрос мастера. `existing` - значение из текущего .env: показывается маской и
// подставляется по Enter. Проверяется ИТОГОВОЕ значение, а не только набранное: иначе
// негодное значение, уже лежащее в файле, доживает до записи и роняет прогон на
// последнем шаге, унося все ответы владельца.
const ask = async (q: string, def = "", existing = "") => {
  // Негодное значение из существующего .env не предлагается по Enter: иначе вопрос
  // зациклится (Enter → отказ → тот же вопрос). Говорим о нём один раз и спрашиваем
  // заново с чистого листа.
  const carried = existing || def;
  const carriedComplaint = carried ? envComplaint(carried) : null;
  if (carriedComplaint) {
    console.log(
      `${C.y}  ⚠ ${t("The value in .env cannot stay", "Значение из .env оставить нельзя")}: ${carriedComplaint}${C.x}\n`,
    );
    existing = "";
    def = "";
  }
  for (;;) {
    const typed = (
      await rl.question(def ? `${q} [${def}]: ` : `${q}: `)
    ).trim();
    const a =
      existing && (!typed || typed.endsWith(KEEP())) ? existing : typed || def;
    const complaint = envComplaint(a);
    if (!complaint) return a;
    console.log(`${C.y}  ⚠ ${complaint}${C.x}\n`);
  }
};
const askYesNo = async (q: string, def = false) => {
  const a = await ask(`${q} (${def ? "Y/n" : "y/N"})`);
  return a ? isYesAnswer(a) : def;
};

// Free-port selection: ask for the desired port, check availability with the same Probe as
// `check-port` (scripts/lib/ports.ts); if taken, offer the nearest free one. Closes the root of a
// bug at setup time — the server won't start on an occupied port.
async function pickPort(def: string) {
  const checker = defaultChecker();
  for (;;) {
    const port = Number(
      await ask(
        `  ${t("Local eve-server port", "Порт локального eve-сервера")}`,
        String(def),
      ),
    );
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.log(
        `  ${C.r}${t("Invalid port", "Некорректный порт")}${C.x} — ${t("must be a number 1..65535.", "нужно число 1..65535.")}`,
      );
      continue;
    }
    const { occupied, holders } = await checker.check(port);
    if (!occupied) return String(port);
    const reuse = await confirmOccupiedCurrentPort({
      port,
      currentPort: def,
      holders,
      confirm: async ({ port: current, holders: found }) => {
        const who = found.length ? ` (${found.join("; ")})` : "";
        console.log(
          `  ${C.y}${t(
            `Port ${current} is already occupied${who}. Ownership cannot be verified.`,
            `Порт ${current} уже занят${who}. Проверить владельца надёжно нельзя.`,
          )}${C.x}`,
        );
        return askYesNo(
          `  ${t(
            `Keep occupied port ${current}? Only confirm if it is the running Iva`,
            `Оставить занятый порт ${current}? Подтверди, только если это запущенная Iva`,
          )}`,
          false,
        );
      },
    });
    if (reuse) return String(port);
    const free = await new PortSelector(checker).firstFree(port + 1);
    const who = holders.length ? ` (${holders.join("; ")})` : "";
    console.log(
      `  ${C.y}${t(`Port ${port} is busy${who}.`, `Порт ${port} занят${who}.`)}${C.x}${free ? ` ${t("Nearest free", "Ближайший свободный")}: ${C.g}${free}${C.x}.` : ""}`,
    );
    if (
      free &&
      (await askYesNo(`  ${t(`Take ${free}?`, `Взять ${free}?`)}`, true))
    )
      return String(free);
    // otherwise loop — the user enters another port manually
  }
}
const mask = (s: string) => (s ? s.slice(0, 6) + KEEP() : "");
const hr = () =>
  console.log(`${C.c}  ────────────────────────────────────────────${C.x}`);
const head = (n: number, title: string) =>
  console.log(
    `\n${C.b}${C.c}  ${t("Step", "Шаг")} ${n}/${TOTAL}: ${title}${C.x}`,
  );

// Repeats the question until it gets a non-empty and (if set) valid value.
async function askRequired(
  label: string,
  { help = "", existing = "", validate }: AskRequiredOptions = {},
) {
  for (;;) {
    if (help) console.log(help);
    let a = await ask(label, existing ? mask(existing) : "", existing);
    a = (a || "").trim();
    if (!a) {
      console.log(
        `${C.y}  ⚠ ${t("Required field — Iva won't run without it. Enter a value.", "Обязательное поле — без него Iva не заработает. Введите значение.")}${C.x}\n`,
      );
      continue;
    }
    if (validate) {
      process.stdout.write(`  ${t("checking…", "проверяю…")} `);
      const err = await validate(a);
      if (err) {
        console.log(
          `${C.r}${t("not ok", "не ок")}${C.x}\n${C.y}  ⚠ ${err}${C.x}\n`,
        );
        continue;
      }
      console.log(`${C.g}${t("ok", "ок")}${C.x}`);
    }
    return a;
  }
}

async function loadExistingEnv(): Promise<Env> {
  try {
    // parseEnvText, а не своя регулярка: мастер обязан судить о существующей
    // настройке по тому значению, которое получит запущенный агент.
    return parseEnvText(await readFile(SOURCE_ENV_PATH, "utf8"));
  } catch (error) {
    if ((error as ThrownSetupError | null | undefined)?.code === "ENOENT")
      return {};
    throw error;
  }
}

// Writes .env in a stable key order.
// eslint-disable-next-line @typescript-eslint/require-await -- preserve the original setup microtask boundary.
async function writeEnv(out: Env): Promise<void> {
  const order = [
    "AGENT_LANGUAGE",
    "MODEL_PROVIDER",
    "OLLAMA_API_KEY",
    "OLLAMA_MODEL",
    "OLLAMA_VISION_MODEL",
    "OLLAMA_CONTEXT_WINDOW",
    "OPENCODE_API_KEY",
    "OPENCODE_MODEL",
    "OPENCODE_VISION_MODEL",
    "OPENCODE_CONTEXT_WINDOW",
    "OPENROUTER_API_KEY",
    "OPENROUTER_MODEL",
    "OPENROUTER_VISION_MODEL",
    "OPENROUTER_CONTEXT_WINDOW",
    "CODEX_MODEL",
    "CODEX_CONTEXT_WINDOW",
    "CUSTOM_BASE_URL",
    "CUSTOM_API_KEY",
    "CUSTOM_MODEL",
    "CUSTOM_VISION_MODEL",
    "CUSTOM_CONTEXT_WINDOW",
    "CUSTOM_REASONING",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_BOT_USERNAME",
    "TELEGRAM_WEBHOOK_SECRET_TOKEN",
    "TELEGRAM_ALLOWED_USER_IDS",
    "TELEGRAM_DIGEST_CHAT_ID",
    "DEEPGRAM_API_KEY",
    "DEEPGRAM_LANGUAGE",
    "SEARCH_PROVIDER",
    "TAVILY_API_KEY",
    "BRAVE_API_KEY",
    "EXA_API_KEY",
    "PARALLEL_API_KEY",
    "MEMORY_SEARCH_MODE",
    "JINA_API_KEY",
    "DEEPINFRA_API_KEY",
    "ASSISTANT_TIMEZONE",
    "ASSISTANT_VAULT_DIR",
    "ASSISTANT_DATA_DIR",
    "IVA_PORT",
    "ASSISTANT_HOST",
    "ASSISTANT_BEARER",
  ];
  const keys = [
    ...order.filter((k) => out[k] != null),
    ...Object.keys(out).filter((k) => !order.includes(k)),
  ];
  // Строку, которую мастер сочинил сам, он обязан записать в безопасном подмножестве -
  // это и проверяется при каждом вопросе. Но в .env попадает и то, что уже лежало там
  // до нас: чужой ключ вроде `my.key`, значение с кириллицей, краевым пробелом или
  // переносом строки. Дословно такую строку не записать: значение с переносом строки
  // разваливается надвое, и вторая половина становится настоящей переменной, которой
  // владелец не задавал (так подменялся ASSISTANT_DATA_DIR). Поэтому строка не пишется
  // вовсе, а ключ называется вслух - молча терять строку владельца нельзя. Уронить
  // весь прогон на последнем шаге и потерять все ответы хуже и того, и другого.
  const lines: string[] = [];
  for (const k of keys) {
    try {
      lines.push(formatEnvLine(k, String(out[k])));
    } catch {
      console.log(
        `${C.y}  ⚠ ${t(
          `Dropped ${k} from the existing .env: the service and the iva command would read it differently. Set it again by hand if you need it.`,
          `${k} не перенесён из существующего .env: сервис и команда iva прочитали бы его по-разному. Задайте его заново вручную, если он нужен.`,
        )}${C.x}`,
      );
    }
  }
  writeEnvAtomicSync(ENV_PATH, lines.join("\n") + "\n");
}

async function ollamaModels(key: string): Promise<string[]> {
  const res = await fetch(`${OLLAMA_BASE}/models`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error("key rejected"), { auth: true });
  }
  if (!res.ok) throw new Error(`Ollama API returned ${res.status}`);
  const body = (await res.json()) as ModelListResponse;
  return (body.data || []).map((model) => model.id).sort();
}
async function opencodeCheck(key: string): Promise<string | null> {
  try {
    const res = await fetch(`${OPENCODE_BASE}/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.status === 401 || res.status === 403) {
      return t(
        "OpenCode rejected the key (401/403). Check your Go subscription and that the key was copied in full.",
        "OpenCode не принял ключ (401/403). Проверьте подписку Go и что ключ скопирован целиком.",
      );
    }
    return null; // 200/404 — key is at least well-formed
  } catch {
    return null; // network flaky — don't block
  }
}
// Live Go model list (bare IDs). The catalog drifts (kimi-k3 appeared, qwen3.7 was retired),
// so the hardcoded list is only a fallback for when the endpoint is unreachable.
async function opencodeModels(key: string): Promise<string[]> {
  try {
    const res = await fetch(`${OPENCODE_BASE}/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return OPENCODE_MODELS;
    const body = (await res.json()) as ModelListResponse;
    const ids = (body.data || []).map((model) => model.id).sort();
    return ids.length ? ids : OPENCODE_MODELS;
  } catch {
    return OPENCODE_MODELS;
  }
}
// OpenRouter: ключ проверяем через GET /key (требует auth, токенов не тратит).
async function openrouterKeyCheck(key: string): Promise<string | null> {
  try {
    const res = await fetch(`${OPENROUTER_BASE}/key`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.status === 401 || res.status === 403) {
      return t(
        "OpenRouter rejected the key (401/403). Copy it in full from https://openrouter.ai/keys (starts with sk-or-).",
        "OpenRouter не принял ключ (401/403). Скопируйте целиком с https://openrouter.ai/keys (начинается с sk-or-).",
      );
    }
    return null; // 200 (или иной не-401) — ключ well-formed
  } catch {
    return null; // сеть флапнула — не блокируем
  }
}
// OpenRouter: ЖИВОЙ тест модели — реальный вызов chat/completions выбранным слагом.
// Запрос НЕСЁТ минимальный tools-блок: Iva — агент, каждый ход шлёт tool-definitions, поэтому
// chat-only модель (без function calling) сломается на первом же ходе. Один запрос ловит всё:
//   кривой слаг → 400 "not a valid model id";  битый ключ → 401;
//   модель без tool-эндпоинта → 404 "No endpoints found that support tool use".
// Не-200 → возвращаем строку → мастер зациклит ввод. Именно это ловит «принято, а агент молчит».
// OpenRouter оборачивает upstream-ошибку провайдера: error.message = generic "Provider returned error",
// а настоящая причина (напр. "not available in your region") лежит в error.metadata.raw как JSON-строка.
// Разворачиваем её, иначе пользователь видит бессмысленную обёртку.
async function openrouterModelCheck(
  key: string,
  model: string,
): Promise<string | null> {
  try {
    const result = await probeOpenRouterModel(
      { model, key },
      {
        errorReason: openrouterErrReason,
      },
    );
    if (!result.answered) {
      console.log(
        `${C.y}${t("(model replied empty — maybe a reasoning model / max_tokens; proceeding)", "(модель ответила пусто — возможно reasoning-модель / max_tokens; продолжаю)")}${C.x}`,
      );
    }
    return null;
  } catch (error) {
    const caught = error as ThrownSetupError | null | undefined;
    if (
      caught?.code === "model_unavailable" ||
      caught?.code === "auth_rejected"
    ) {
      const reason = caught.message;
      const toolIssue =
        /tool use|function call|no endpoints found that support tool/i.test(
          reason,
        );
      const hint = toolIssue
        ? t(
            "Iva needs a chat model with tool/function calling — pick one on https://openrouter.ai/models (form vendor/model).",
            "Iva нужна chat-модель с поддержкой инструментов (function calling) — выберите такую на https://openrouter.ai/models (вид vendor/model).",
          )
        : t(
            "pick another model on https://openrouter.ai/models (form vendor/model).",
            "выберите другую модель на https://openrouter.ai/models (вид vendor/model).",
          );
      return t(
        `the model can't be used: ${reason}. ${hint}`,
        `модель не подходит: ${reason}. ${hint}`,
      );
    }
    return t(
      `request failed: ${(error as ThrownSetupError).message}`,
      `запрос не прошёл: ${(error as ThrownSetupError).message}`,
    );
  }
}
async function deepgramCheck(key: string): Promise<string | null> {
  try {
    const res = await fetch(`${process.env.DEEPGRAM_BASE_URL ?? "https://api.deepgram.com"}/v1/projects`, {
      headers: { Authorization: `Token ${key}` },
    });
    if (res.status === 401 || res.status === 403) {
      return t(
        "Deepgram rejected the key (401/403). Copy the key in full from the API Keys page.",
        "Deepgram не принял ключ (401/403). Скопируйте ключ целиком со страницы API Keys.",
      );
    }
    return null;
  } catch {
    return null;
  }
}
async function telegramGetMe(token: string): Promise<TelegramBot | undefined> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const body = (await res.json()) as TelegramGetMeResponse;
  if (!body.ok) throw new Error(body.description || "token rejected");
  return body.result;
}
async function fetchTelegramUserIds(token: string): Promise<TelegramUser[]> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  const body = (await res.json()) as TelegramUpdatesResponse;
  if (!body.ok) throw new Error(body.description || "getUpdates failed");
  const seen = new Map<string, TelegramUser>();
  for (const update of body.result || []) {
    const message = update.message || update.edited_message;
    const from = message?.from;
    if (from && !seen.has(String(from.id))) {
      const name = [
        from.first_name,
        from.last_name,
        from.username ? `@${from.username}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      seen.set(String(from.id), {
        id: String(from.id),
        name: name || t("(no name)", "(без имени)"),
      });
    }
  }
  return [...seen.values()];
}

// Pick from a list by number (with a default). Returns the chosen item.
async function pickFromList(
  items: string[],
  current: string,
  recommended: string,
): Promise<string> {
  items.forEach((id, i) =>
    console.log(
      `   ${String(i + 1).padStart(2)}. ${id}${id === recommended ? `  ${C.g}★${C.x}` : ""}`,
    ),
  );
  const curIdx = items.indexOf(current);
  const recIdx = items.indexOf(recommended);
  const defNum = (curIdx >= 0 ? curIdx : Math.max(0, recIdx)) + 1;
  const ch = await ask(
    `\n  ${t("Model number", "Номер модели")}`,
    String(defNum || 1),
  );
  let idx = parseInt(ch, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= items.length) idx = defNum - 1;
  return items[idx];
}

export async function main(entryUrl = import.meta.url): Promise<void> {
  if (!isEntrypoint(entryUrl)) return;
  const existing = await loadExistingEnv();
  const out = { ...existing };
  out.ASSISTANT_BEARER = isAssistantBearer(existing.ASSISTANT_BEARER)
    ? existing.ASSISTANT_BEARER.trim()
    : generateAssistantBearer();

  await askLanguage(out, existing);

  // Already configured? Don't walk every step — ask once.
  const config = existingConfiguration(existing);
  if (!config.cat0)
    console.log(
      `\n${C.y}  ⚠ ${t(
        `MODEL_PROVIDER is invalid (${config.prov0}) — Iva won't start until you pick one below.`,
        `MODEL_PROVIDER невалиден (${config.prov0}) — Iva не стартует, пока не выберешь провайдера ниже.`,
      )}${C.x}`,
    );
  if (config.isComplete) {
    if (!(await keepCurrentConfiguration(existing, out, config))) {
      rl.close();
      return;
    }
  } else {
    printFreshSetupIntro();
  }

  const provider = await askProviderChoice(config.prov0);
  out.MODEL_PROVIDER = provider;

  const state = { existing, out, provider };
  const ctx = createSetupContext();
  await askProviderSettings(state, ctx);
  await askKeysSettings(state, ctx);
  await askTelegramSettings(state, ctx);
  await askVaultAndPort(state, ctx);
  await writeSetupEnv(state, ctx, STAGING_CONFIG);
  rl.close();
}

// ── Language: UI + agent's default reply language ─────────────────
// install.sh asks for the language FIRST and passes it through the environment (AGENT_LANGUAGE) —
// in that case don't ask again. On a standalone `npm run setup` the env is empty → we ask.
async function askLanguage(out: Env, existing: Env): Promise<void> {
  const envLang = (process.env.AGENT_LANGUAGE || "").toLowerCase();
  if (envLang === "en" || envLang === "ru") {
    LANG = envLang;
  } else {
    console.log(`\n${C.b}${C.c}  🌐 Language / Язык${C.x}`);
    console.log("    1) English");
    console.log("    2) Русский");
    const langChoice = await ask(
      "  Choose / Выбор (1/2)",
      existing.AGENT_LANGUAGE === "ru" ? "2" : "1",
    );
    LANG = menuChoice(langChoice) === 2 ? "ru" : "en";
  }
  out.AGENT_LANGUAGE = LANG;
  console.log(
    `  → ${t("Iva will reply in English by default.", "Iva будет отвечать по-русски по умолчанию.")}`,
  );
}

type ExistingConfiguration = {
  readonly prov0: string;
  readonly cat0: ReturnType<typeof catalogProvider>;
  readonly provModel: string;
  readonly provKey: string | null;
  readonly isComplete: boolean;
};

// Провайдер берётся ТОЧНЫМ именем из общего каталога — того же, на который смотрят рантайм
// и доктор. Неизвестное имя (опечатка `ollmaa`) не сходится ни с одним ключом: раньше карты
// промахивались, API-ключ выпадал из REQUIRED, мастер объявлял сломанный .env настроенным и
// выходил — а это тот самый мастер, к которому отказ агента и отправляет (issue #161).
// `??`, не `||`: `MODEL_PROVIDER=` в .env — это заданное пустое значение, и рантайм,
// доктор, статус и апдейт его отвергают. Схлопни его здесь в ollama — и единственный
// экран, который умеет починить, снова объявил бы сломанный .env настроенным.
function existingConfiguration(existing: Env): ExistingConfiguration {
  const prov0 = existing.MODEL_PROVIDER ?? "ollama";
  const cat0 = catalogProvider(prov0);
  const provModel = cat0?.modelVar ?? "OLLAMA_MODEL";
  // codex — доступ по OAuth-токену (data/codex-auth.json), у ollama/opencode/openrouter — API-ключ в .env.
  // Список ключей общий с `iva doctor`: иначе один объявил бы .env полным, а второй — нет.
  const provKey = cat0?.keyVar ?? null;
  const REQUIRED = [
    ...(cat0 ? providerEnvKeys(cat0) : []),
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_ALLOWED_USER_IDS",
  ];
  const loggedInCodex =
    prov0 !== "codex" || existsSync(authFilePath(dataDirAbs(existing)));
  const isComplete =
    Boolean(cat0) &&
    loggedInCodex &&
    REQUIRED.every((k) => (existing[k] || "").trim());
  return { prov0, cat0, provModel, provKey, isComplete };
}

/**
 * Полная настройка: один вопрос вместо шагов. True — владелец перенастраивается, wizard
 * идёт дальше; false — настройки оставлены как есть (с проверкой и записью, если план
 * это требует), и wizard завершён.
 */
async function keepCurrentConfiguration(
  existing: Env,
  out: Env,
  config: ExistingConfiguration,
): Promise<boolean> {
  console.log(
    `\n${C.b}${C.g}  ${t("Iva is already configured:", "Iva уже настроена:")}${C.x}`,
  );
  console.log(`  • ${t("Provider", "Провайдер")}: ${config.prov0}`);
  console.log(`  • ${t("Model", "Модель")}:    ${existing[config.provModel]}`);
  console.log(
    `  • ${t("Bot", "Бот")}:       @${existing.TELEGRAM_BOT_USERNAME || "?"}`,
  );
  console.log(
    `  • ${t("Access", "Доступ")}:    ${existing.TELEGRAM_ALLOWED_USER_IDS}`,
  );
  console.log(
    `  • Deepgram:  ${existing.DEEPGRAM_LANGUAGE || "multi"}   ·   TZ: ${existing.ASSISTANT_TIMEZONE || "?"}`,
  );
  if (
    await askYesNo(
      `\n  ${t("Reconfigure from scratch?", "Перенастроить заново?")}`,
      false,
    )
  ) {
    console.log(
      `\n  ${t("Going step by step.", "Идём по шагам.")} ${C.y}${t("Enter at each step keeps the current value.", "Enter на каждом шаге оставит текущее значение.")}${C.x}`,
    );
    return true;
  }
  if (keptSetupWritePlan(existing, out) === "validate-and-write") {
    await validateModelSelection({
      provider: config.prov0,
      model: existing[config.provModel],
      key: config.provKey ? existing[config.provKey] || undefined : undefined,
      dataDir: dataDirAbs(existing),
      ...(config.cat0 ? { base: providerBase(config.cat0, existing) } : {}),
    });
    await writeEnv(out);
  }
  console.log(
    `${C.g}  ${t("Keeping current settings — nothing to enter.", "Оставляю текущие настройки как есть — ничего вводить не нужно.")}${C.x}`,
  );
  return false;
}

/** Свежая настройка: что сейчас будет. */
function printFreshSetupIntro(): void {
  console.log(
    `\n${C.b}${C.g}  ${t("Iva setup — entering secrets step by step", "Настройка Iva — вводим секреты по шагам")}${C.x}`,
  );
  console.log(
    `  ${t("Takes a couple of minutes. For each key I'll tell you where to get it and check it on the spot.", "Займёт пару минут. Для каждого ключа подскажу, где его взять, и проверю на месте.")}`,
  );
  console.log(
    `  ${C.y}${t("The script won't exit until you've entered every required secret.", "Скрипт не завершится, пока вы не введёте все обязательные секреты.")}${C.x}`,
  );
}

// ── Step 1: model provider + model ────────────────────────────────
async function askProviderChoice(prov0: string): Promise<string> {
  head(
    1,
    t("Provider and model — Iva's brain", "Провайдер и модель — мозг Iva"),
  );
  console.log(
    `  ${t("Who to reach the model through:", "Через кого ходить к модели:")}`,
  );
  console.log(
    `    1) Ollama Cloud — ${C.c}https://ollama.com${C.x} ${t("(~$20/mo, higher limits)", "(~$20/мес, лимиты побольше)")}`,
  );
  console.log(
    `    2) OpenCode Go — ${C.c}https://opencode.ai/go${C.x} ${t("(~$5/mo, cheaper)", "(~$5/мес, дешевле)")}`,
  );
  console.log(
    `    3) OpenAI ${t("(ChatGPT subscription)", "(подписка ChatGPT)")} — ${C.c}chatgpt.com${C.x} ${t("(sign in, no API key)", "(вход по подписке, без API-ключа)")}`,
  );
  console.log(
    `    4) OpenRouter — ${C.c}https://openrouter.ai${C.x} ${t("(one key → 300+ models, pay-as-you-go)", "(один ключ → 300+ моделей, оплата по факту)")}`,
  );
  console.log(
    `    5) ${t("Custom — your own OpenAI-compatible endpoint", "Custom — свой OpenAI-совместимый эндпоинт")} ${t("(proxy, vLLM, LiteLLM, a vendor plan)", "(прокси, vLLM, LiteLLM, вендорская подписка)")}`,
  );
  const provDef =
    { opencode: "2", codex: "3", openrouter: "4", custom: "5" }[prov0] || "1";
  const provChoice = menuChoice(
    await ask(`  ${t("Provider", "Провайдер")} (1/2/3/4/5)`, provDef),
  );
  return provChoice === 2
    ? "opencode"
    : provChoice === 3
      ? "codex"
      : provChoice === 4
        ? "openrouter"
        : provChoice === 5
          ? "custom"
          : "ollama";
}

/** Контекст мастера: живой диалог, сеть и запись .env — то, что шаги получают параметром. */
function createSetupContext(): SetupContext {
  return {
    t,
    lang: () => LANG,
    print: (...args: unknown[]) => console.log(...args),
    write: (text: string) => {
      process.stdout.write(text);
    },
    ask,
    askYesNo,
    askRequired,
    mask,
    pickFromList,
    pickPort,
    head,
    hr,
    envValue: (name) => process.env[name],
    dataDirAbs,
    readAuth,
    listCodexModels,
    runBrowserLogin,
    runDeviceCodeLogin,
    fetchModels,
    validateModelSelection,
    writeEnv,
    ollamaModels,
    opencodeCheck,
    opencodeModels,
    openrouterKeyCheck,
    openrouterModelCheck,
    deepgramCheck,
    telegramGetMe,
    fetchTelegramUserIds,
  };
}

void main().catch((error) => {
  const caught = error as ThrownSetupError | null | undefined;
  console.error(
    `${C.r}${t("Setup aborted:", "Настройка прервана:")}${C.x}`,
    caught?.message || error,
  );
  process.exit(1);
});
