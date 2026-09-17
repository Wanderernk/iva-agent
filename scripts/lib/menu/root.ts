// Корневой экран /menu: одна rich-карта — заголовок, затем строка «кнопка — что она
// делает» на каждый раздел. Все кнопки несут либо навигацию (o-верб к под-экрану), либо
// хендофф (mdl/thk), либо закрытие (r:x) — их целиком обрабатывает движок, поэтому on()
// тут пустой.
//
// Правило репо: ни одной module-level const с переведённой строкой — все подписи собираются
// в render() через ctx.tr, иначе язык замёрзнет до рестарта.
import { button, type RichButtonStyle } from "./buttons.ts";
import { menuStyle } from "../telegram-buttons.ts";

interface RootContext {
  tr: (english: string, russian: string) => string;
}

type RootState = Record<string, unknown>;

export default {
  parent: null,
  render(_state: RootState, ctx: RootContext) {
    const T = ctx.tr;
    const item = (
      label: string,
      data: string,
      what: string,
      style?: RichButtonStyle,
    ) => `${button(label, data, style)} — ${what}`;
    const text = [
      `# ${T("⚙️ Settings", "⚙️ Настройки")}`,
      item(
        T("🧠 Model", "🧠 Модель"),
        "iva_menu:mdl",
        T(
          "switch the provider, the model and the key.",
          "сменить провайдера, модель и ключ.",
        ),
      ),
      item(
        T("🤔 Thinking", "🤔 Размышления"),
        "iva_menu:thk",
        T(
          "how long to think before answering.",
          "сколько думать перед ответом.",
        ),
      ),
      item(
        T("🔍 Search", "🔍 Поиск"),
        "iva_menu:srch:o",
        T(
          "the web-search provider and its key.",
          "веб-провайдер поиска и его ключ.",
        ),
      ),
      item(
        T("💬 Rich replies", "💬 Богатые ответы"),
        "iva_menu:rich:o",
        T(
          "tables and folds as a rich message or as plain text.",
          "таблицы и свёртки богатым сообщением или обычным текстом.",
        ),
      ),
      item(
        T("🎤 Voice", "🎤 Голос"),
        "iva_menu:voice:o",
        T(
          "the key that transcribes voice notes, and the language.",
          "ключ распознавания голосовых и язык.",
        ),
      ),
      item(
        T("🌐 Language", "🌐 Язык"),
        "iva_menu:lang:o",
        T("the language of the menu and replies.", "язык меню и ответов."),
      ),
      item(
        T("🎭 Character", "🎭 Характер"),
        "iva_menu:chr:o",
        T(
          "a 10-question test that sets what Iva is like.",
          "тест из 10 вопросов — какой ты хочешь видеть иву.",
        ),
      ),
      item(
        T("💾 Memory", "💾 Память"),
        "iva_menu:core:o",
        T(
          "what Iva remembers about you, plus a 6-question interview.",
          "что ива помнит о тебе, и интервью из 6 вопросов.",
        ),
      ),
      item(
        T("📡 Userbot", "📡 Userbot"),
        "iva_menu:ub:o",
        T(
          "access to your own Telegram account.",
          "доступ к твоему аккаунту Telegram.",
        ),
      ),
      item(
        T("🔗 Google", "🔗 Google"),
        "iva_menu:gws:o",
        T(
          "access to Gmail, Calendar and Drive.",
          "доступ к Gmail, Календарю и Drive.",
        ),
      ),
      item(
        T("⏰ Timers", "⏰ Кроны"),
        "iva_menu:cron:o",
        T(
          "systemd timers, tasks in the queue and reminders.",
          "таймеры systemd, задачи в очереди и напоминания.",
        ),
      ),
      item(
        T("🔔 Notices", "🔔 Уведомления"),
        "iva_menu:ntc:o",
        T(
          "memory reports and the morning digest.",
          "отчёты памяти и утренний дайджест.",
        ),
      ),
      item(
        T("🧩 Skills", "🧩 Скиллы"),
        "iva_menu:sk:o",
        T("the list of what Iva can do.", "список того, что ива умеет."),
      ),
      item(
        T("📊 Status", "📊 Статус"),
        "iva_menu:st:o",
        T(
          "version, model, search and today's spend.",
          "версия, модель, поиск и расход за сегодня.",
        ),
      ),
      item(
        T("🔀 New messages", "🔀 Новые сообщения"),
        "iva_menu:turn:o",
        T(
          "wait for the current reply or interrupt it.",
          "ждать текущий ответ или перебивать.",
        ),
      ),
      item(
        T("🛠 Maintenance", "🛠 Обслуживание"),
        "iva_menu:svc:o",
        T(
          "doctor, vault cleanup and updates.",
          "доктор, чистка vault и обновление.",
        ),
      ),
      // Новое (rich) меню носит внизу выход в старое: кому не зашло, вернётся одним тапом.
      ...(menuStyle() === "rich"
        ? [
            item(
              T("◀︎ Classic menu", "◀︎ Старое меню"),
              "iva_menu:svc:menu:classic",
              T(
                "buttons under the message, as before.",
                "кнопки под сообщением, как раньше.",
              ),
            ),
          ]
        : []),
      item(
        T("✖ Close", "✖ Закрыть"),
        "iva_menu:r:x",
        T("remove this menu.", "убрать это меню."),
        "danger",
      ),
    ];
    return { text: text.join("\n\n") };
  },
  on(...args: unknown[]) {
    void args;
  },
};
