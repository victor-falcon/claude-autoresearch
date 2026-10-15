# claude-autoresearch

Autonomous experiment loop for [Claude Code](https://claude.com/claude-code): try an idea, measure it, keep what works, discard what doesn't, repeat.

A port of [davebcn87/pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) (itself inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch)) to Claude Code, built as a mod (function-hooks plugin) plus skills.

> 🚧 Work in progress.

## Requirements

- `/autoresearch export` (the live browser dashboard) runs a small local server with **Node.js** (`node` on `PATH`, any current LTS). It listens on `127.0.0.1` only and stops on `/autoresearch off`, `/autoresearch clear` and when the session ends. The browser opens with `open` (macOS) or `xdg-open` (Linux); the command also prints the URL.

## Development

Requirements: Node 22.18+ and Claude Code on `PATH` (no API key needed for any of these).

```sh
npm install
npm run types      # lay the mod API types (.claude-plugin/types/, git-ignored; needed before typecheck)
npm run typecheck  # tsc over the mod and over the pure core
npm test           # core + dashboard server tests (node --test) + mod tests (claude plugin test)
npm run validate   # claude plugin validate .
```

To try the mod in a session: `claude --plugin-dir .`

Layout: `hooks/register.tsx` is a thin composition root that calls one `register*` per feature folder under `src/` (`tools`, `command`, `loop`, `ui`, `export`); `src/runtime/` holds the shared `$.state`/`$.fs` glue; `src/core/` is the pure, unit-tested logic ported from pi-autoresearch; `types/index.d.ts` is the `$.state` contract.

## License

MIT — see [LICENSE](LICENSE). Original work © Tobi Lutke, David Cortés.
