#!/usr/bin/env bash
# On a discard, ask a cheap model to critique the failed hypothesis.
# Uses headless Claude Code (`claude -p`) with a small model; swap ask_model
# for any short-prompt CLI (llm, llama-cli, ollama, a local endpoint via curl,
# etc.). Keep it fast: hooks are killed after 30 s.
#
# Ported from pi-autoresearch (https://github.com/davebcn87/pi-autoresearch)
# by Tobi Lutke and David Cortés, MIT.

set -euo pipefail

readonly MODEL="haiku"

fired_on_discard() {
  [ "$(jq -r '.last_run.status // empty' <<<"$1")" = "discard" ]
}

critique_prompt() {
  local hyp="$1" reason="$2"
  printf 'Hypothesis "%s" was discarded because: %s.\n' "$hyp" "$reason"
  printf 'Name two adjacent directions that might work instead. One sentence each.'
}

ask_model() {
  claude -p --model "$MODEL" --no-session-persistence "$1"
}

input="$(cat)"
fired_on_discard "$input" || exit 0
command -v claude >/dev/null || exit 0

hyp=$(jq -r '.last_run.asi.hypothesis // "unknown"' <<<"$input")
reason=$(jq -r '.last_run.asi.rollback_reason // "unknown"' <<<"$input")
ask_model "$(critique_prompt "$hyp" "$reason")"
