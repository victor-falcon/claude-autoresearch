#!/usr/bin/env bash
# Lays the engine's mod API declarations (claude-code.d.ts) where a loaded mod
# gets them, .claude-plugin/types/claude-code/index.d.ts, so `tsc` can
# type-check the mod outside a hot-reloading session (CI included).
#
# Claude Code writes the file when its built-in plugin-authoring skill loads.
# Loading the skill needs no model call, so this runs it with a dummy API key:
# no tokens are spent and no login is needed. The model request that follows
# fails, which is expected.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
claude_bin="${CLAUDE_BIN:-claude}"
dest="$root/.claude-plugin/types/claude-code/index.d.ts"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

(
  cd "$tmp"
  CLAUDE_CODE_TMPDIR="$tmp/tmp" CLAUDE_CONFIG_DIR="$tmp/config" ANTHROPIC_API_KEY=dummy-no-model-call \
    $claude_bin -p "/plugin-authoring" >"$tmp/claude.log" 2>&1 || true
)

types="$(find "$tmp/tmp" -name claude-code.d.ts -path '*plugin-authoring/types/*' 2>/dev/null | head -n 1 || true)"
if [[ -z "$types" ]]; then
  echo "fetch-types: Claude Code did not write claude-code.d.ts; its output:" >&2
  cat "$tmp/claude.log" >&2
  exit 1
fi

mkdir -p "$(dirname "$dest")"
cp "$types" "$dest"
echo "fetch-types: $(head -n 1 "$dest" | sed 's#^// ##') -> ${dest#"$root/"}"
