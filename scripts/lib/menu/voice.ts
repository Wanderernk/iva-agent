// Экран «Голос» (/menu → 🎤): ключ Deepgram и язык распознавания голосовых.
//
// Инварианты ключа те же, что у экрана поиска (scripts/lib/menu/search.ts): значение никогда
// не попадает в лог/eve/текст ошибки, сообщение с ключом удаляет САМ движок (index.ts onText,
// secret:true) ДО вызова texts.deepgramkey, приём разрешён только в личке (проверка при установке
// awaitText — обязанность экрана). DEEPGRAM_API_KEY и DEEPGRAM_LANGUAGE читает agent/transcribe.ts
// из окружения процесса, поэтому после записи предлагаем перезапуск iva.service.
//
// Живой проверки ключа, как checkSearchKey у поиска, здесь нет намеренно: у Deepgram в
// репозитории нет проверяющего хелпера, а плодить второй сетевой путь ради меню нечем —
// о неверном ключе скажет первый же голосовой по своему коду ошибки. Проверяется только
// форма: ключ и значение, которое .env сохранит целиком.
import { envValueRejection, readEnvValues, upsertEnv } from "../env-file.ts";
import { button, buttonRow, escapeRichText } from "./buttons.ts";

const SID = "voice";
const PARENT = "r";
const KEY_VAR = "DEEPGRAM_API_KEY";
const LANG_VAR = "DEEPGRAM_LANGUAGE";
// Ровно те значения, что предлагает экран; всё прочее (напр. ru-RU) трансляция отдаёт как есть.
const LANGS = ["multi", "ru", "en", "uz"] as const;
type Language = (typeof LANGS)[number];
type AwaitText = { kind: string; secret: boolean };
type MenuState = { chatId: number; awaitText: AwaitText | null };
type MenuContext = {
  deps: {
    envPath: string;
    sc: (action: string, unit: string) => Promise<boolean>;
  };
  tr: (english: string, russian: string) => string;
  show: (state: MenuState, screen: string) => Promise<void>;
  flows: {
    screen: (state: MenuState, text: string) => Promise<void>;
    end: (state: MenuState, text: string) => Promise<void>;
  };
};

const isLanguage = (value: unknown): value is Language =>
  LANGS.includes(value as Language);

// Язык из .env: пусто — multi (дефолт transcribe.ts). Любой другой код — законное значение
// (Deepgram понимает BCP-47), поэтому показываем его как есть, а не подменяем дефолтом.
function configuredLanguage(env: Record<string, string | undefined>): string {
  const raw = (env[LANG_VAR] ?? "").trim();
  return raw === "" ? "multi" : raw;
}

const languageLabel = (value: string, ctx: MenuContext) =>
  value === "multi"
    ? ctx.tr("Auto", "Авто")
    : value === "ru"
      ? "Русский"
      : value === "en"
        ? "English"
        : value === "uz"
          ? "Oʻzbek"
          : escapeRichText(value);

const backLine = (ctx: MenuContext) =>
  `${button(ctx.tr("‹ Menu", "‹ Меню"), `iva_menu:${PARENT}:o`)} — ${ctx.tr(
    "back to the settings.",
    "вернуться в настройки.",
  )}`;

const cancelLine = (ctx: MenuContext) =>
  `${button(ctx.tr("Cancel", "Отмена"), `iva_menu:${SID}:o`, "danger")} — ${ctx.tr(
    "leave the prompt without entering a key.",
    "выйти из ввода, ничего не меняя.",
  )}`;

// Telegram: id личных чатов положительны, групп/супергрупп — отрицательны. Секреты
// принимаем только в личке (в группе бот может не иметь прав на удаление, и ключ увидят
// посторонние). st не хранит chat.type, поэтому опираемся на знак chatId — надёжно.
const isPrivate = (st: MenuState) => Number(st.chatId) > 0;

// Экран «режим записан — применить перезапуском?». Обе настройки экрана читает процесс агента
// при старте, поэтому путь один: запись в .env → этот экран.
async function restartOffer(st: MenuState, ctx: MenuContext) {
  const text = [
    `# ${ctx.tr("🎤 Voice", "🎤 Голос")}`,
    ctx.tr(
      "Saved. The transcriber reads the key and the language as the agent starts, so it applies after a restart.",
      "Сохранил. Ключ и язык трансляция читает при старте агента, поэтому применится после перезапуска.",
    ),
    buttonRow([
      button(
        ctx.tr("Restart now", "Перезапустить сейчас"),
        `iva_menu:${SID}:rs:now`,
      ),
      button(ctx.tr("Later", "Позже"), `iva_menu:${SID}:rs:later`),
    ]),
    backLine(ctx),
  ].join("\n\n");
  return ctx.flows.screen(st, text);
}

// Экран-приглашение ввести ключ: ставит awaitText (перехват следующего текста движком) и
// говорит, что будет дальше. secret:true — приём только в личке (иначе отказ).
async function promptKey(st: MenuState, ctx: MenuContext) {
  if (!isPrivate(st)) {
    st.awaitText = null;
    return ctx.flows.screen(
      st,
      `${ctx.tr(
        "A key is a secret — open a private chat with me and set the Deepgram key there.",
        "Ключ — это секрет. Открой личный чат со мной и введи ключ Deepgram там.",
      )}\n\n${backLine(ctx)}`,
    );
  }
  st.awaitText = { kind: "deepgramkey", secret: true };
  const text = [
    `# ${ctx.tr("🎤 Deepgram key", "🎤 Ключ Deepgram")}`,
    ctx.tr(
      "Send it in the next message — I'll delete it from the chat right away. Create it at console.deepgram.com.",
      "Пришли его следующим сообщением — я сразу удалю его из чата. Ключ можно получить на console.deepgram.com.",
    ),
    cancelLine(ctx),
  ].join("\n\n");
  return ctx.flows.screen(st, text);
}

export default {
  parent: PARENT,

  async render(st: MenuState, ctx: MenuContext) {
    st.awaitText = null; // возврат на экран снимает возможный ждущий ввод ключа
    const env = await readEnvValues(ctx.deps.envPath);
    const hasKey = Boolean(env[KEY_VAR]);
    const language = configuredLanguage(env);
    const text = [
      `# ${ctx.tr("🎤 Voice", "🎤 Голос")}`,
      `${ctx.tr("Deepgram key", "Ключ Deepgram")}: ${hasKey ? ctx.tr("set", "есть") : ctx.tr("not set", "нет")}.`,
      ...(hasKey
        ? []
        : [
            ctx.tr(
              "Voice notes aren't transcribed without a key.",
              "Без ключа голосовые не распознаются.",
            ),
          ]),
      `${ctx.tr("Language", "Язык")}: ${languageLabel(language, ctx)}.`,
      `${button(ctx.tr("🔑 Set the key", "🔑 Указать ключ"), `iva_menu:${SID}:key`)} — ${ctx.tr(
        "send the key in the next message, I'll delete it from the chat.",
        "пришли ключ следующим сообщением, я удалю его из чата.",
      )}`,
      buttonRow(
        LANGS.map((value) =>
          button(
            `${languageLabel(value, ctx)}${value === language ? " ✓" : ""}`,
            `iva_menu:${SID}:lang:${value}`,
          ),
        ),
      ),
      backLine(ctx),
    ].join("\n\n");
    return { text };
  },

  async on(verb: string, args: string[], st: MenuState, ctx: MenuContext) {
    if (verb === "key") return promptKey(st, ctx);
    if (verb === "lang") {
      const value = args[0];
      if (!isLanguage(value)) return ctx.show(st, SID);
      // Смена языка уводит с приглашения вводить ключ: без этого следующий обычный текст
      // владельца был бы съеден как ключ (движок снимает ожидание только на нав-вербах).
      st.awaitText = null;
      await upsertEnv(ctx.deps.envPath, { [LANG_VAR]: value });
      return restartOffer(st, ctx);
    }
    if (verb === "rs") {
      if (args[0] === "now") {
        // plain restart — не restartAgent(): смена настройки не «сброс», диалоги живут.
        const ok = await ctx.deps.sc("restart", "iva.service");
        return ctx.flows.end(
          st,
          ok
            ? ctx.tr(
                "♻️ Restarting the agent — voice notes are transcribed in ~30s.",
                "♻️ Перезапускаю агента — голосовые распознаются через ~30 сек.",
              )
            : ctx.tr(
                "⚠️ Couldn't restart (systemctl). Check the service on the server.",
                "⚠️ Не удалось перезапустить (systemctl). Проверь сервис на сервере.",
              ),
        );
      }
      return ctx.flows.end(
        st,
        ctx.tr(
          "Saved. It'll apply on the next restart (/restart).",
          "Сохранил. Применится после перезапуска (/restart).",
        ),
      );
    }
    return ctx.show(st, SID);
  },

  texts: {
    // Приём ключа Deepgram. Сообщение уже удалено движком (secret:true) до этого вызова.
    // Значение ключа не пишется в лог/reply/eve ни при каком исходе.
    async deepgramkey(
      text: unknown,
      _msg: unknown,
      st: MenuState,
      ctx: MenuContext,
    ) {
      const value = String(text).trim();
      // Мало быть похожим на ключ: значение обязано выжить в .env целиком (его читают оба
      // парсера — systemd EnvironmentFile и node --env-file). Причина отказа не содержит
      // значения — только класс символа.
      const problem = envValueRejection(value);
      if (!/^\S{8,}$/.test(value) || problem) {
        st.awaitText = null;
        return ctx.flows.end(
          st,
          ctx.tr(
            "That key won't do: either it isn't a key, or it has a character .env can't keep (#, a quote, a space). The prompt is cleared, I deleted the message just in case.",
            "Такой ключ не приму: либо это не ключ, либо в нём символ, которого .env не сохранит (#, кавычка, пробел). Ожидание снято, сообщение удалил на всякий случай.",
          ),
        );
      }
      st.awaitText = null;
      await upsertEnv(ctx.deps.envPath, { [KEY_VAR]: value });
      return restartOffer(st, ctx);
    },
  },
};
