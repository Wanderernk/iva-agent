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

command -v git >/dev/null 2>&1 || die "git is required"
command -v node >/dev/null 2>&1 || die "Node.js is required"

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 24 ] || die "Node 24 or newer is required"

[ -d "$INSTALL_DIR" ] || die "Iva was not found at $INSTALL_DIR"
INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd -P)"
HOME_DIR="$(cd "$HOME" && pwd -P)"
[ "$INSTALL_DIR" != "/" ] || die "unsafe installation path"
[ "$INSTALL_DIR" != "$HOME_DIR" ] || die "unsafe installation path"

# Уже на версионной раскладке: обновлятор в ней и есть весь ремонт. Дерево, которое
# только начало конвертироваться (есть и versions/, и .git), идёт ниже по пути чекаута:
# обновление доводит конверсию само.
if [ -f "$INSTALL_DIR/current/bin/iva.mjs" ]; then
  say "Updating Iva..." "Обновляю Iva..."
  exec node "$INSTALL_DIR/current/bin/iva.mjs" update
fi

[ -f "$INSTALL_DIR/package.json" ] || die "package.json is missing"
node -e 'const p=require(process.argv[1]); if(p.name!=="iva") process.exit(1)' \
  "$INSTALL_DIR/package.json" || die "this is not an Iva installation"
[ -d "$INSTALL_DIR/.git" ] || die "Iva was not found at $INSTALL_DIR"

top="$(git -C "$INSTALL_DIR" rev-parse --show-toplevel)"
[ "$(cd "$top" && pwd -P)" = "$INSTALL_DIR" ] || die "invalid Iva checkout"

# Тот же канал, на котором сидит установка: `iva rollback` пишет его в git config, и
# ремонт не имеет права молча вернуть человека на main.
branch="$(git -C "$INSTALL_DIR" config --get iva.updateBranch || true)"
[ -n "$branch" ] || branch="main"

say "Getting Iva $branch..." "Получаю Iva ($branch)..."
git -C "$INSTALL_DIR" fetch --quiet origin "$branch"
git -C "$INSTALL_DIR" reset --quiet --hard "origin/$branch"
say "Local changes to Iva's code were removed." "Локальные правки в коде удалены."
say "Your .env, data/, vault/ and attachments/ stay in place." "Ваши .env, data/, vault/ и attachments/ остались на месте."

exec node "$INSTALL_DIR/bin/iva.mjs" update
