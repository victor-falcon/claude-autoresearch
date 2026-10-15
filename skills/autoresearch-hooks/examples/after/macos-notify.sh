#!/usr/bin/env bash
# Fires a native desktop notification (and a short note to the agent) only on
# milestone runs. Uses osascript on macOS (built in) and notify-send on Linux
# when available; swap to terminal-notifier or a webhook curl as needed.
#
# Ported from pi-autoresearch (https://github.com/davebcn87/pi-autoresearch)
# by Tobi Lutke and David Cortés, MIT.

set -euo pipefail

readonly TITLE="🏆 autoresearch: new best"

is_new_best() {
  local status="$1" metric="$2" best="$3"
  [ "$status" = "keep" ] && [ -n "$best" ] && [ "$metric" = "$best" ]
}

send_desktop_notification() {
  if command -v osascript >/dev/null; then
    osascript -e "display notification \"$1\" with title \"$TITLE\"" >/dev/null
  elif command -v notify-send >/dev/null; then
    notify-send "$TITLE" "$1"
  fi
}

input="$(cat)"
status=$(jq -r '.run_entry.status' <<<"$input")
metric=$(jq -r '.run_entry.metric' <<<"$input")
best=$(jq -r '.session.best_metric // empty' <<<"$input")
name=$(jq -r '.session.metric_name' <<<"$input")
unit=$(jq -r '.session.metric_unit // ""' <<<"$input")

is_new_best "$status" "$metric" "$best" || exit 0

body="$name = $metric$unit"
send_desktop_notification "$body"
echo "🏆 New best: $body"
