// Одно правило вырезания секретов для всей установки: им режет пакет улик `iva diagnose`
// (scripts/cli/diagnose.ts) и хвост журнала расписания, который агент читает ходом
// пробуждения (agent/lib/job-facts.ts). Второй копии правила в репозитории быть не должно:
// слепая приёмка T20 нашла ровно это — свой шаблон в authored tree пропускал токен внутри
// `bot<token>` и значение ключа без слова-приметы, пока diagnose уже резал и то и другое.
//
// Пакет, а не модуль одного из деревьев: `agent/` не импортирует `scripts/`, а `iva
// diagnose` обязан работать на установке без `agent/` (ADR-0003,
// scripts/authored-tree-guard.test.ts). `packages/` видят оба и его целиком несёт с собой
// собранный рантайм (RUNTIME_SOURCE_TREES в scripts/lib/custom-layer.ts).
//
// Правило не угадывает секрет по виду значения: секрет — значение ЛЮБОГО ключа, кроме
// закрытого списка настроек, плюс пароль из userinfo URL, токен бота в любом месте строки,
// личный id рядом с меткой и e-mail.

/** Пометка вырезанного. Тот же вид, что в правилах про evidence (AGENTS.md). */
export const REDACTED = "<redacted>";

/**
 * Имя ключа `.env`, значение которого НЕ секрет: каталог, модель, провайдер, зона, язык,
 * порт, хост, окно контекста, усилие, режим, ник бота. Режется значение любого другого
 * ключа файла, какой бы длины оно ни было, — список секретов не словарь английских слов, а
 * дополнение к этому списку настроек. Иначе секрет в ключе без слова-приметы уезжает в
 * issue: пароль внутри `CUSTOM_BASE_URL=https://user:pass@host` (ключ из `.env.example`),
 * `CUSTOM_ENDPOINT`, `PROXY`, `*_DSN`, `*_COOKIE`, `SALT`, `PIN`, `OTP` и инвайт-ссылка
 * `SUPPORT_CHAT_URL` в чат владельца (слепая приёмка T21, раунд 3). Настройки остаются
 * целыми не для красоты: `ASSISTANT_DATA_DIR=data` и `ASSISTANT_VAULT_DIR=vault` — слова
 * внутри путей самого пакета, и вырезание съедало их из каждой строки (раунд 2). Список
 * сверяется тестом с `.env.example` и с описью
 * `agent/skills/security-defense/outbound-sensitive-keys.json`.
 */
const CONFIG_KEY =
  /(?:^|_)(?:DIR|MODEL|PROVIDER|TIMEZONE|LANGUAGE|LANG|PORT|WINDOW|EFFORT|MODE|USERNAME|REASONING|MAX_OUTPUT)$|^(?:NODE_ENV|TZ)$/iu;
/** `*_HOST`: настройка, только пока в значении нет ни владельца (`@`), ни пароля после `:`. Со схемой — тоже настройка (`http://host[:port]`), но не с путём и не с userinfo. */
const HOST_KEY = /(?:^|_)HOST$/iu;
const PLAIN_HOST = /^[^\s@:]+(?::\d+)?$/u;
const SCHEME_HOST = /^https?:\/\/[^\s/@:]+(?::\d+)?$/u;
/**
 * Пароль внутри значения с владельцем: `https://user:pass@host`, `user:pass@host`. Значение
 * режется целиком, но в журнал пароль попадает и отдельным словом — строкой апстрима или
 * текстом ошибки, — а целого URL там нет, и по одному полному значению он оставался
 * открытым (слепая приёмка T21, раунд 3).
 */
const URL_PASSWORD = /^(?:[A-Za-z][A-Za-z\d+.-]*:\/\/)?[^\s/@:]*:([^\s/@]+)@/u;
/**
 * Настройки САМОГО ПРОЦЕССА, а не установки: в `.env` таких ключей нет, а в `process.env`
 * они есть всегда — и их значения не секреты. Без этого списка хвост журнала расписания
 * терял смысл: `HOME=/Users/john` вырезал начало каждого пути, `USER=john` — слог внутри
 * слов, `SHLVL=1` — каждую единицу (слепая приёмка T20, раунды 2-3). Переменные systemd
 * (`MANAGERPID`, `SYSTEMD_EXEC_PID`, `INVOCATION_ID`, `JOURNAL_STREAM`) — той же природы:
 * их пишет systemd в окружение сервиса, и pid со stream попадают в хвост провала (T30 v2).
 */
const PROCESS_SETTING_KEY =
  /^(?:HOME|PATH|PWD|OLDPWD|SHLVL|SHELL|USER|LOGNAME|TERM|COLORTERM|TERM_PROGRAM|TERM_PROGRAM_VERSION|TERM_SESSION_ID|LANG|LC_[A-Z_]+|TMPDIR|TMP|TEMP|EDITOR|VISUAL|PAGER|HOSTNAME|DISPLAY|XPC_[A-Z_]+|__CF[A-Z_]+|MANAGERPID|SYSTEMD_EXEC_PID|INVOCATION_ID|JOURNAL_STREAM|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|COMMAND_MODE|INFOPATH|MANPATH|_)$/u;
/** Ключи со списком личных id: их значения делятся по запятой и пробелам. */
const CHAT_ID_KEY = /(?:_CHAT_ID|_USER_IDS|_API_ID)$/u;
/**
 * Токен бота в ЛЮБОМ месте строки. Границы слова тут вредны: в журнале токен стоит внутри
 * URL — `api.telegram.org/bot<token>/sendMessage`, — и lookbehind срывался на букве `t`
 * из `bot`, пропуская чужой токен в пакет (T21). У формы `<5+ цифр>:<25+ знаков>` ложных
 * срабатываний нет, поэтому режем без оглядки на соседей.
 */
const TELEGRAM_TOKEN_RE = /\d{5,}:[A-Za-z0-9_-]{25,}/gu;
/**
 * Личный id рядом с меткой: `tg:555000111222:43`, `chat_id=…`, `chatId: …`, `from=…`.
 * Работает БЕЗ `.env` — иначе chat id из журнала хода уезжает в пакет (личные данные).
 * Голые длинные числа не трогаем: тогда пакет превратился бы в кашу из времён и размеров.
 */
const TELEGRAM_ID_RE =
  /((?:tg|chat|chatId|chat_id|userId|user_id|from|to)(?::|=|%3A|%3D)\s*)\d{5,}/giu;
/**
 * E-mail: адрес начинается на границе локальной части — якорь и есть то, что делает проход
 * линейным. Без него `+` на строке без `@` откатывался на каждой позиции: 64 КБ stderr
 * занимали секунды в главном процессе (verify-ocr-v7 №3); с якорем внутри длинной цепочки
 * знаков проверка отваливается за один знак, а не за всю цепочку. Потолков длин нет: они
 * давали не скорость, а потерю адресов с локальной частью 65+ и доменом 260+.
 */
const EMAIL_RE =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Формы, в которых один и тот же секрет попадает в журнал: сырая, percent-encoded
 * (Basic-строки и куски запросов), JSON-экранированная (тело запроса уехало в лог целиком)
 * и base64/base64url (заголовки авторизации). Список — функция от секрета, поэтому режется
 * всё, чем секрет может приехать, а не только то, как он лежит в `.env`.
 */
function secretForms(secret: string): string[] {
  return [
    secret,
    // Многострочное значение (кавычка в `.env`) приезжает в журнал и построчно: каждая
    // непустая строка — такая же форма секрета, как целое значение (слепая приёмка T21).
    ...secret
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    encodeURIComponent(secret),
    JSON.stringify(secret).slice(1, -1),
    Buffer.from(secret, "utf8").toString("base64"),
    Buffer.from(secret, "utf8").toString("base64url"),
  ];
}

/**
 * Чистая: каждая форма секрета, токен бота в любом месте строки, личный id рядом с меткой и
 * e-mail становятся пометкой. Формы режутся ОДНИМ проходом и от длинной к короткой: иначе
 * второй проход резал бы буквы внутри только что вставленной пометки, а короткая форма
 * съедала бы начало длинной (короткий секрет-префикс оставлял хвост длинного — T21).
 * Форма короче 4 знаков режется только на границе слова: однобуквенный пароль `p` внутри
 * `https://u:p@host` выделяется и так (`:p@`), а `package` и `output` остаются целыми (T26).
 * Порог — строго ниже минимальной длины секрета в property-тесте (4): четырёхзначные
 * формы обязаны резаться везде, даже приклеенными к мусору, иначе тест «ни одна форма
 * не выживает» краснеет контрпримером вида `0!!!!` (проверено: при пороге 5 он красный).
 */
const SHORT_FORM = 4;
/**
 * Знак hex внутри percent-escape: регистр роли не играет (`%2f` = `%2F`), поэтому каждая
 * буква становится классом. Буквы самого секрета — не знаки escape, их регистр значим.
 */
function percentEscapePattern(char: string): string {
  return /[0-9]/u.test(char)
    ? char
    : `[${char.toLowerCase()}${char.toUpperCase()}]`;
}
function formPattern(form: string): string {
  // Percent-форма приезжает и со строчными буквами hex (`%2f`): заменяем знаки escape на
  // регистронезависимые классы после экранирования формы (а не регистронезависимым флагом
  // на всю форму — тогда строчная форма секрета вроде `alpha%2fbeta` съедала бы чужой текст).
  const raw = escapeRegExp(form).replace(
    /%([0-9A-Fa-f]{2})/gu,
    (_match, hex: string) => `%${[...hex].map(percentEscapePattern).join("")}`,
  );
  return form.length < SHORT_FORM
    ? `(?<![\\p{L}\\p{N}])${raw}(?![\\p{L}\\p{N}])`
    : raw;
}
export function redact(text: string, secrets: readonly string[]): string {
  const forms = new Set<string>();
  for (const secret of secrets)
    for (const form of secretForms(secret))
      if (form.length > 0) forms.add(form);
  const ordered = [...forms].sort((left, right) => right.length - left.length);
  let out = text;
  if (ordered.length > 0) {
    out = out.replace(
      new RegExp(ordered.map(formPattern).join("|"), "gu"),
      REDACTED,
    );
  }
  return out
    .replace(TELEGRAM_TOKEN_RE, REDACTED)
    .replace(TELEGRAM_ID_RE, `$1${REDACTED}`)
    .replace(EMAIL_RE, REDACTED);
}

/**
 * Какие значения `.env` считать секретами. Имена ключей берутся из самого файла: список
 * не угадывается по виду значения. Секрет — значение ЛЮБОГО ключа, кроме настроечных
 * (CONFIG_KEY, `*_HOST` без владельца и пароля): неизвестный и пользовательский ключ по
 * умолчанию режется, потому что задача тут — утечка, а не полнота пакета. Пустое значение
 * не режется (пометка вместо пустоты выглядела бы как найденный секрет). Ветвь CHAT_ID_KEY
 * делит значение на части: личные id пишут через запятую.
 */
export function secretValuesFromEnv(env: Record<string, string>): string[] {
  const values: string[] = [];
  for (const [key, raw] of Object.entries(env)) {
    const value = raw.trim();
    if (value.length === 0) continue;
    if (CHAT_ID_KEY.test(key)) {
      values.push(
        ...value
          .split(/[,\s]+/u)
          .map((part) => part.trim())
          .filter((part) => part.length > 0),
      );
      continue;
    }
    if (CONFIG_KEY.test(key) || PROCESS_SETTING_KEY.test(key)) continue;
    if (
      HOST_KEY.test(key) &&
      (PLAIN_HOST.test(value) || SCHEME_HOST.test(value))
    )
      continue;
    values.push(value);
    const password = URL_PASSWORD.exec(value)?.[1];
    if (password) values.push(password);
  }
  return values;
}
