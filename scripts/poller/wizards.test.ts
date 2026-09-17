/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node owns test registration; the async request double preserves the wizard boundary. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ContextWindowConfigurationError } from "../../agent/lib/context-window.ts";
import { MODEL_PROVIDER_NAMES } from "#lib/model-provider.ts";
import { CATALOG } from "../lib/model-catalog.ts";
import { DATA_DIR_ABS } from "./config.ts";
import {
  currentConfig,
  flows,
  getWizard,
  handleThinkCmd,
  handleWizardText,
  isStaleWizard,
  resetMessageCopy,
  runWizardRequest,
  selectWizardEffort,
  selectWizardModel,
  selectableWizardOptions,
  validateAndSaveWizard,
  wizardActionAllowed,
} from "./wizards.ts";

test("reset copy rejects an invalid context window with the typed error", () => {
  assert.throws(
    () =>
      resetMessageCopy("/new", {
        MODEL_PROVIDER: "codex",
        CODEX_CONTEXT_WINDOW: "1e3",
      }),
    ContextWindowConfigurationError,
  );
});

// Визард — путь починки: он открывается ИМЕННО тогда, когда MODEL_PROVIDER набран с
// опечаткой и агент не стартует. Назови он такую конфигурацию «ollama» — пользователь
// увидел бы здоровую строку и ушёл искать причину в другом месте.
test("the model wizard shows the configured provider, valid or not", async () => {
  for (const name of MODEL_PROVIDER_NAMES) {
    const config = await currentConfig({
      readEnv: async () => ({ MODEL_PROVIDER: name }),
    });
    assert.equal(config.providerLabel, name);
    assert.equal(config.provider, name);
    // У custom дефолтной модели нет: пустой .env честно показывается «?», а не именем,
    // к которому агент не пойдёт.
    assert.equal(config.model, CATALOG[name].def ?? "?");
  }
  // Через живой .env сюда приходит то, что оставил парсер scripts/lib/env-file.ts: он
  // срезает обрамляющие пробелы, поэтому в списке их нет. Это правило ИМЕННО этого
  // парсера — у мастера установки свой, и их поведение на пробелах не сверяется. Здесь
  // readEnv подставлен, так что проверяется предикат, а не парсер.
  for (const value of ["ollmaa", "OLLAMA", "", "__proto__"]) {
    const config = await currentConfig({
      readEnv: async () => ({ MODEL_PROVIDER: value }),
    });
    assert.equal(config.providerLabel, `invalid (${value})`, value);
    // Кнопки всё же надо чем-то нарисовать — визард встаёт на дефолтном провайдере.
    assert.equal(config.provider, "ollama", value);
  }
  // Переменной нет — это не опечатка, а дефолт: он и остаётся ollama.
  const missing = await currentConfig({ readEnv: async () => ({}) });
  assert.equal(missing.provider, "ollama");
  assert.equal(missing.providerIsValid, true);
});

// /think и /model читают одно и то же состояние. Раньше /think видел схлопнутую в ollama
// подмену и рисовал уровни, как будто всё в порядке, — настройка уезжала в .env, а агент
// всё равно не стартовал. Флаг тот же, что рисует метку в /model.
test("the thinking wizard sees the same invalid provider the model wizard shows", async () => {
  for (const value of ["ollmaa", "OLLAMA", ""]) {
    const config = await currentConfig({
      readEnv: async () => ({ MODEL_PROVIDER: value, THINKING_EFFORT: "high" }),
    });
    assert.equal(config.providerIsValid, false, value);
    assert.equal(config.providerLabel, `invalid (${value})`, value);
  }
  for (const name of MODEL_PROVIDER_NAMES) {
    const config = await currentConfig({
      readEnv: async () => ({ MODEL_PROVIDER: name }),
    });
    assert.equal(config.providerIsValid, true, name);
  }
});

test("wizard lookup preserves Telegram's string user ID", () => {
  const chatId = 4_102_033;
  const userId = "9_104_204";
  const state = flows.start(chatId, userId, "model");

  assert.equal(getWizard(chatId, userId), state);
});

test("wizard action guards, model selection and effort selection preserve the state machine", () => {
  const state: {
    step: string;
    modelOptions: { id: string; reasoningLevels: string[] }[];
    efforts?: string[];
    effort?: string | null;
    model?: string;
  } = {
    step: "models",
    modelOptions: [
      { id: "first", reasoningLevels: ["low", "high"] },
      { id: "second", reasoningLevels: [] },
    ],
  };
  assert.equal(wizardActionAllowed(state, "m:0"), true);
  assert.equal(wizardActionAllowed(state, "eff:low"), false);
  assert.equal(wizardActionAllowed({ step: "intro" }, "chg"), true);
  assert.equal(wizardActionAllowed(null, "cancel"), false);
  assert.equal(isStaleWizard({ msgId: 10 }, 11), true);
  assert.equal(isStaleWizard({ msgId: 10 }, 10), false);

  const selected = selectWizardModel(state, "0");
  assert.ok(selected);
  assert.equal(selected.id, "first");
  assert.deepEqual(state.efforts, ["low", "high"]);
  assert.equal(selectWizardModel(state, "01"), null);
  assert.equal(selectWizardEffort(state, "high"), true);
  assert.equal(state.effort, "high");
  assert.equal(selectWizardEffort(state, "unset"), true);
  assert.equal(state.effort, null);
});

test("wizard options prioritize the configured model and async results are dropped when stale", async () => {
  const options = [
    { id: "a", reasoningLevels: [] },
    { id: "b", reasoningLevels: [] },
    { id: "c", reasoningLevels: [] },
  ];
  assert.deepEqual(
    selectableWizardOptions(options, "c", 2).map((option) => option.id),
    ["c", "a"],
  );
  const state = {};
  assert.deepEqual(
    await runWizardRequest(
      state,
      async () => "result",
      () => false,
    ),
    { stale: true },
  );
});

type SentCall = { method: string; text: string };
type MockResponse = { ok: boolean; status: number; json(): Promise<unknown> };
const mutableGlobal = globalThis as unknown as {
  fetch: (url: string, init?: { body?: string }) => Promise<MockResponse>;
};

/** Ловит всё, что визард действительно отправляет: путь в Telegram у моста ровно один. */
function telegramSpy(t: TestContext): SentCall[] {
  const sent: SentCall[] = [];
  const previous = mutableGlobal.fetch;
  t.after(() => {
    mutableGlobal.fetch = previous;
  });
  mutableGlobal.fetch = (url, init) => {
    const method = url.split("/").at(-1) ?? "";
    if (url.includes("api.telegram.org")) {
      const body = JSON.parse(init?.body ?? "{}") as {
        text?: string;
        rich_message?: { markdown?: string };
      };
      // Экраны визарда — rich: текст экрана лежит в rich_message.markdown.
      sent.push({
        method,
        text: body.rich_message?.markdown ?? body.text ?? "",
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, result: { message_id: 7 } }),
      });
    }
    // Каталог моделей провайдера — только для контрольного случая.
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [{ id: "deepseek-v4-pro" }] }),
    });
  };
  return sent;
}

// Гвард в /think до этого не вызывал ни один тест: удали его — и весь сьют оставался
// зелёным, пока живой визард рисовал уровни ollama поверх сломанной конфигурации.
test("/think refuses an invalid provider and sends the user to /model", async (t) => {
  const sent = telegramSpy(t);

  await handleThinkCmd(4102033, "9104204", {
    readEnv: async () => ({
      MODEL_PROVIDER: "ollmaa",
      THINKING_EFFORT: "high",
    }),
  });

  const texts = sent.map((call) => call.text).join("\n");
  assert.match(
    texts,
    /MODEL_PROVIDER is (now )?invalid \(ollmaa\)|invalid \(ollmaa\)/u,
  );
  assert.match(texts, /\/model/u);
  // Ни экрана загрузки уровней, ни самих уровней: настраивать нечего.
  assert.doesNotMatch(texts, /Loading thinking levels/u);
  assert.doesNotMatch(texts, /reply_markup.*eff:/u);
});

// ─── custom: свой OpenAI-совместимый эндпоинт ─────────────────────────────────────────
// Адрес и имя модели у него приходят текстом, а не кнопкой: курировать нечего, и GET
// /models эндпоинт не обязан отдавать вовсе.

type WizardStateForTest = {
  chatId: number;
  userId: string;
  provider: string;
  model: string;
  step: string;
  awaitText: { kind: string; secret: boolean; data: object } | null;
  pendingBase?: string | null;
  pendingKey?: string | null;
  dropKey?: boolean;
  effort: string | null;
  efforts: string[];
  modelOptions: { id: string; reasoningLevels: string[] }[];
  flow: string;
};

/** Живой слот визарда: без него runWizardRequest и wizScreen считают состояние протухшим. */
function customWizard(
  chatId: number,
  userId: string,
  step: string,
  kind: string,
): WizardStateForTest {
  const st = flows.start(
    chatId,
    userId,
    "model",
  ) as unknown as WizardStateForTest;
  st.provider = "custom";
  st.step = step;
  st.awaitText = { kind, secret: false, data: {} };
  st.pendingBase = null;
  return st;
}

test("«Без ключа» живёт только на экране ввода ключа", () => {
  assert.equal(wizardActionAllowed({ step: "awaiting_key" }, "nokey"), true);
  for (const step of ["intro", "provider", "models", "effort", "saved"])
    assert.equal(wizardActionAllowed({ step }, "nokey"), false, step);
});

test("the endpoint address is refused until it is one, then kept normalized", async (t) => {
  const sent = telegramSpy(t);
  const st = customWizard(4102040, "9104210", "awaiting_base", "baseurl");

  for (const raw of ["api.example.com/v1", "   ", "ftp://api.example.com/v1"]) {
    await handleWizardText(
      { chat: { id: st.chatId }, message_id: 11, text: raw },
      st as never,
    );
    assert.equal(st.pendingBase, null, raw);
    // Ожидание ввода снято не было: следующий текст всё ещё принадлежит визарду.
    assert.equal(st.awaitText?.kind, "baseurl", raw);
  }
  assert.match(
    sent.map((call) => call.text).join("\n"),
    /https:\/\/api\.example\.com\/v1/u,
  );

  await handleWizardText(
    {
      chat: { id: st.chatId },
      message_id: 12,
      text: "  https://api.example.com/v1//  ",
    },
    st as never,
  );
  assert.equal(st.pendingBase, "https://api.example.com/v1");
  // Адрес принят — визард пошёл дальше по обычному порядку шагов, к ключу.
  assert.equal(st.awaitText?.kind, "apikey");
  assert.equal(st.step, "awaiting_key");
});

test("a typed model id is refused when it is not one line", async (t) => {
  telegramSpy(t);
  const st = customWizard(4102041, "9104211", "awaiting_model", "modelid");
  st.pendingBase = "https://api.example.com/v1";

  for (const raw of ["", "   ", "one\ntwo"]) {
    await handleWizardText(
      { chat: { id: st.chatId }, message_id: 13, text: raw },
      st as never,
    );
    assert.equal(st.model, null, JSON.stringify(raw));
    assert.equal(st.awaitText?.kind, "modelid", JSON.stringify(raw));
  }
});

// Что именно уезжает в .env — единственное место, где выбор превращается в конфигурацию.
test("saving custom writes the endpoint, the model and drops a key nobody wants", async () => {
  const seen: { selection: unknown; updates: unknown }[] = [];
  const st = {
    flow: "model",
    provider: "custom",
    model: "some-model",
    effort: null,
    pendingBase: "https://api.example.com/v1",
    pendingKey: null,
    dropKey: true,
  };

  await validateAndSaveWizard(st as never, {
    readEnv: async () => ({
      CUSTOM_API_KEY: "stale-key-from-another-endpoint",
    }),
    validate: (selection: unknown) => {
      seen.push({ selection, updates: null });
      return Promise.resolve({ id: "some-model", reasoningLevels: [] });
    },
    write: (updates: Record<string, string | null>) => {
      seen.push({ selection: null, updates });
      return Promise.resolve();
    },
  });

  assert.deepEqual(seen[0].selection, {
    provider: "custom",
    model: "some-model",
    // Ключ владелец отменил — проверять модель идём без него.
    key: undefined,
    dataDir: DATA_DIR_ABS,
    base: "https://api.example.com/v1",
  });
  assert.deepEqual(seen[1].updates, {
    THINKING_EFFORT: null,
    MODEL_PROVIDER: "custom",
    CUSTOM_MODEL: "some-model",
    CUSTOM_BASE_URL: "https://api.example.com/v1",
    // null сносит строку: старый ключ не должен уехать на новый эндпоинт.
    CUSTOM_API_KEY: null,
  });
});

test("a custom key entered in the dialog is written next to the endpoint", async () => {
  let written: Record<string, string | null> = {};
  await validateAndSaveWizard(
    {
      flow: "model",
      provider: "custom",
      model: "some-model",
      effort: null,
      pendingBase: "https://api.example.com/v1",
      pendingKey: "secret",
    } as never,
    {
      readEnv: async () => ({}),
      validate: () =>
        Promise.resolve({ id: "some-model", reasoningLevels: [] }),
      write: (updates: Record<string, string | null>) => {
        written = updates;
        return Promise.resolve();
      },
    },
  );
  assert.equal(written.CUSTOM_API_KEY, "secret");
  assert.equal(written.CUSTOM_BASE_URL, "https://api.example.com/v1");
});

test("/think still works on a provider the runtime accepts", async (t) => {
  const sent = telegramSpy(t);

  await handleThinkCmd(4102034, "9104205", {
    readEnv: async () => ({
      MODEL_PROVIDER: "ollama",
      OLLAMA_API_KEY: "key",
      OLLAMA_MODEL: "deepseek-v4-pro",
    }),
  });

  const texts = sent.map((call) => call.text).join("\n");
  assert.doesNotMatch(texts, /invalid \(/u);
  assert.match(texts, /Loading thinking levels|deepseek-v4-pro/u);
});
