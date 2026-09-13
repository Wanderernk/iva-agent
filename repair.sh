#!/usr/bin/env bash
set -Eeuo pipefail

# One command for an Iva that cannot update itself any more. It repairs nothing on its
# own: it puts the installation back on the release and hands the work to the one
# updater, exactly as `iva update` would.
#   curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/repair.sh | bash

INSTALL_DIR="${IVA_INSTALL_DIR:-${HOME}/iva}"

lang="en"
case "${AGENT_LANGUAGE:-}" in ru) lang="ru" ;; esac
if [ -z "${AGENT_LANGUAGE:-}" ] && [ -f "$INSTALL_DIR/.env" ]; then
  case "$(grep -E '^AGENT_LANGUAGE=' "$INSTALL_DIR/.env" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"' || true)" in
    ru) lang="ru" ;;
  esac
fi

# Каждое сообщение - двумя языками сразу, как их пишет установщик: en-строка первая.
say() { if [ "$lang" = "ru" ]; then printf '%s\n' "$2"; else printf '%s\n' "$1"; fi; }
die() { printf 'Iva repair failed: %s\n' "$*" >&2; exit 1; }
# Отказ, который читает владелец: тем же двуязычием, что и всё остальное.
fail() {
  if [ "$lang" = "ru" ]; then printf 'Ремонт Iva не выполнен: %s\n' "$2" >&2; else printf 'Iva repair failed: %s\n' "$1" >&2; fi
  exit 1
}

command -v git >/dev/null 2>&1 || die "git is required"
command -v node >/dev/null 2>&1 || die "Node.js is required"

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 24 ] || die "Node 24 or newer is required"

[ -d "$INSTALL_DIR" ] || die "Iva was not found at $INSTALL_DIR"
INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd -P)"
HOME_DIR="$(cd "$HOME" && pwd -P)"
[ "$INSTALL_DIR" != "/" ] || die "unsafe installation path"
[ "$INSTALL_DIR" != "$HOME_DIR" ] || die "unsafe installation path"

# Дерево разработчика ремонт не трогает совсем, и раньше всего прочего: `git reset --hard`
# ниже снёс бы незакоммиченную работу, а обновление такому дереву всё равно отказывает
# (scripts/cli/version-update-command.ts).
if [ -f "$INSTALL_DIR/.iva-dev" ]; then
  fail "this is a development checkout (.iva-dev): update it with git, build it with \`npm run build\`" \
    "это чекаут разработчика (.iva-dev): обновляйся через git, собирай \`npm run build\`"
fi

# Самая свежая версия на диске - ею ремонтируется установка, у которой `current` потерян
# (обрыв на переключении): сам обновлятор переключение и доводит.
newest_version_entry() {
  local newest="" candidate
  for candidate in "$INSTALL_DIR"/versions/*/bin/iva.mjs; do
    [ -f "$candidate" ] || continue
    if [ -z "$newest" ] || [ "$candidate" -nt "$newest" ]; then newest="$candidate"; fi
  done
  printf '%s' "$newest"
}

# Уже на версионной раскладке: обновлятор в ней и есть весь ремонт. Дерево, которое
# только начало конвертироваться (есть и versions/, и .git), идёт ниже по пути чекаута:
# обновление доводит конверсию само.
if [ -f "$INSTALL_DIR/current/bin/iva.mjs" ]; then
  say "Updating Iva..." "Обновляю Iva..."
  exec node "$INSTALL_DIR/current/bin/iva.mjs" update
fi
if [ -d "$INSTALL_DIR/versions" ] && [ ! -d "$INSTALL_DIR/.git" ]; then
  entry="$(newest_version_entry)"
  [ -n "$entry" ] || fail \
    "the versions in $INSTALL_DIR have no Iva to run - reinstall with install.sh" \
    "в $INSTALL_DIR нет версии, которую можно запустить - переустановите через install.sh"
  say "The last update stopped while switching versions; starting the update from the version on disk." \
    "Прошлое обновление оборвалось на переключении версий; запускаю обновление из версии на диске."
  exec node "$entry" update
fi

[ -f "$INSTALL_DIR/package.json" ] || die "package.json is missing"
node -e 'const p=require(process.argv[1]); if(p.name!=="iva") process.exit(1)' \
  "$INSTALL_DIR/package.json" || die "this is not an Iva installation"
[ -d "$INSTALL_DIR/.git" ] || die "Iva was not found at $INSTALL_DIR"

top="$(git -C "$INSTALL_DIR" rev-parse --show-toplevel)"
[ "$(cd "$top" && pwd -P)" = "$INSTALL_DIR" ] || die "invalid Iva checkout"

# Ремонт запускает код, который сам же и притянул: тянуть его можно только из репозитория
# проекта. Локальный bare-репозиторий - фикстура теста, всё прочее чужое.
is_official_remote() {
  case "$1" in
    https://github.com/smixs/iva-agent|https://github.com/smixs/iva-agent.git|git@github.com:smixs/iva-agent|git@github.com:smixs/iva-agent.git|ssh://git@github.com/smixs/iva-agent|ssh://git@github.com/smixs/iva-agent.git) return 0 ;;
    https://github.com/smixs/iva|https://github.com/smixs/iva.git|git@github.com:smixs/iva|git@github.com:smixs/iva.git|ssh://git@github.com/smixs/iva|ssh://git@github.com/smixs/iva.git) return 0 ;;
    *) return 1 ;;
  esac
}

origin_url="$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || true)"
if ! is_official_remote "$origin_url"; then
  [ -d "$origin_url" ] \
    && [ "$(git --git-dir="$origin_url" rev-parse --is-bare-repository 2>/dev/null)" = "true" ] \
    || die "origin is not github.com/smixs/iva-agent"
fi

# Тот же канал, на котором сидит установка: `iva rollback` пишет его в git config, и
# ремонт не имеет права молча вернуть человека на main.
branch="$(git -C "$INSTALL_DIR" config --get iva.updateBranch || true)"
[ -n "$branch" ] || branch="main"

say "Getting Iva $branch..." "Получаю Iva ($branch)..."
# FETCH_HEAD, не `origin/<ветка>`: remote-tracking ref у установки может не существовать
# (клон без него, свёрнутый refspec), и тогда reset падал бы, оставив дерево как было.
git -C "$INSTALL_DIR" fetch --quiet origin "$branch"
git -C "$INSTALL_DIR" reset --quiet --hard FETCH_HEAD
say "Local changes to Iva's code were removed." "Локальные правки в коде удалены."
say "Your .env, data/, vault/ and attachments/ stay in place." "Ваши .env, data/, vault/ и attachments/ остались на месте."

exec node "$INSTALL_DIR/bin/iva.mjs" update
