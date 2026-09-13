#!/usr/bin/env bash
set -Eeuo pipefail
# Collect an Iva evidence package and send it to the owner's chat with the bot.
# User-facing entrypoint (nothing to type but this line):
#   curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/diagnose.sh | bash
# Secrets are cut by `iva diagnose` itself; on an Iva older than 0.4.1 (no `iva diagnose`)
# the package is the service journal instead. The file goes ONLY to the bot owner's chat.
INSTALL_DIR="${IVA_INSTALL_DIR:-${HOME}/iva}"
say() { printf '%s\n' "$*"; }
die() { printf 'Iva diagnose failed: %s\n' "$*" >&2; exit 1; }

[ -d "$INSTALL_DIR" ] || die "Iva was not found at $INSTALL_DIR"
ENV_FILE="$INSTALL_DIR/.env"
[ -f "$ENV_FILE" ] || die ".env was not found at $ENV_FILE"
if [ -d "$INSTALL_DIR/current" ]; then ROOT="$INSTALL_DIR/current"; else ROOT="$INSTALL_DIR"; fi
env_value() { grep -E "^$1=" "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '"' || true; }
DATA_DIR="$(env_value ASSISTANT_DATA_DIR)"; DATA_DIR="${DATA_DIR:-data}"
case "$DATA_DIR" in /*) ;; *) DATA_DIR="$ROOT/$DATA_DIR" ;; esac
BOT="$(env_value TELEGRAM_BOT_TOKEN)"
CHAT="$(env_value TELEGRAM_ALLOWED_USER_IDS | cut -d, -f1)"
[ -n "$BOT" ] && [ -n "$CHAT" ] || die "TELEGRAM_BOT_TOKEN or TELEGRAM_ALLOWED_USER_IDS is missing in .env"

IVA="$(command -v iva || true)"
[ -n "$IVA" ] || IVA="$HOME/.local/bin/iva"
PACKAGE=""
if [ -x "$IVA" ] && "$IVA" diagnose >/dev/null 2>&1; then
  PACKAGE="$(ls -t "$DATA_DIR"/diagnose/*.md 2>/dev/null | head -n1 || true)"
fi
if [ -z "$PACKAGE" ]; then
  # Older Iva: no `iva diagnose`. The journal of the three units is the next best thing.
  mkdir -p "$DATA_DIR/diagnose"
  PACKAGE="$DATA_DIR/diagnose/journal-$(date +%Y%m%d-%H%M%S).txt"
  {
    say "# Iva journal package (iva diagnose is not available on this version)"
    say "root: $ROOT"; say "version: $(cat "$ROOT/package.json" 2>/dev/null | grep '"version"' || true)"
    say; say "## systemctl"; systemctl --user status iva.service iva-telegram-poll.service --no-pager 2>&1 | head -40 || true
    say; say "## journal (iva.service, iva-telegram-poll.service, iva-self-update*, last 300 lines)"
    journalctl --user -u iva.service -u iva-telegram-poll.service -u 'iva-self-update*' -n 300 --no-pager 2>&1 || true
    say; say "## last update log"
    LAST_LOG="$(ls -t "$DATA_DIR"/logs/update-*.log 2>/dev/null | head -n1 || true)"
    [ -n "$LAST_LOG" ] && tail -n 200 "$LAST_LOG" || say "(none)"
  } | sed -E 's/(TOKEN|KEY|SECRET|BEARER)=[^ ]*/\1=<cut>/g; s#bot[0-9]+:[A-Za-z0-9_-]+#bot<cut>#g' > "$PACKAGE"
fi

RESPONSE="$(curl -s -F "chat_id=$CHAT" -F "document=@$PACKAGE" -F "caption=Iva diagnose $(date +%Y-%m-%d\ %H:%M)" "https://api.telegram.org/bot$BOT/sendDocument" || true)"
case "$RESPONSE" in
  *'"ok":true'*) say "Sent to your chat with the bot: $(basename "$PACKAGE"). Forward it to the maintainer." ;;
  *) die "could not send the package: $(printf '%s' "$RESPONSE" | head -c 200). The file is here: $PACKAGE" ;;
esac
