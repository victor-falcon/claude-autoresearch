# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.2.0] - 2026-10-16

### Changed

- Autoresearch mode no longer turns on by itself when Claude Code opens in a directory with a session log. It only turns on with `/autoresearch <text>`, so `/autoresearch off` is no longer undone by the next session.

## [0.1.0] - 2026-10-15

First release: a port of [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) (by Tobi Lutke and David Cortés, MIT) from pi to Claude Code, as a mod (function-hooks plugin) plus plugin skills. Session files are compatible with pi-autoresearch.

### Added

- **Tools** `mcp__autoresearch__init_experiment`, `run_experiment` and `log_experiment`, with upstream's semantics and texts. They load up front while autoresearch mode is on; while it is off they are deferred, marked inactive, and refused.
  - `run_experiment` has no fixed time cap: it honours `timeout_seconds` (default 600) and kills the whole process tree on timeout, parses `METRIC` lines, keeps a rolling output tail, and runs `.auto/checks.sh` after a passing benchmark (`checks_timeout_seconds`, default 300).
  - `log_experiment` commits on `keep`, reverts on `discard`/`crash`/`checks_failed` while preserving `.auto/` and legacy `autoresearch.*` files, records the MAD confidence score, and enforces `maxIterations`.
- **`.auto/` session files** in the same layout and JSONL shapes as pi-autoresearch (`prompt.md`, `measure.sh`, `log.jsonl`, `checks.sh`, `ideas.md`, `config.json`, `hooks/before.sh|after.sh`), with legacy flat `autoresearch.*` files still read. `config.json` supports `workingDir` and `maxIterations`.
- **Hooks**: `before.sh` and `after.sh` with upstream's stdin contract, 30 s timeout and 8 KB stdout cap. Their output is appended to the `log_experiment` result (or, at activation, to the resume prompt when `.auto/prompt.md` exists).
- **`/autoresearch` command** with `help`, `<text>`, `off`, `finalize`, `clear`, `dashboard` and `export`, and completions for the subcommands. `off` and `finalize` abort the turn and any experiment in flight.
- **Auto-resume loop**: after a turn that logged an experiment, the plugin sends the next iteration prompt itself. It stops on `Escape`, refusals and API errors, after 200 auto-resumed turns or more than 20 consecutive discards or crashes, and when `maxIterations` is reached. Opening Claude Code where a session log exists turns the mode on.
- **Compaction rehydration**: after a compaction while the mode is on, the model gets one prompt built from `.auto/prompt.md`, the ideas backlog, the recent runs and `git log`.
- **System-prompt section** while the mode is on, with a fallback through prompt context where managed settings bypass a user plugin's system-prompt and compaction hooks.
- **Terminal UI**: a widget above the prompt (results table, baseline, progress, secondary metrics, confidence colouring, live spinner) that adapts to narrow and short terminals, a status line, and a fullscreen scrollable dashboard pane (`/autoresearch dashboard`).
- **Browser dashboard** (`/autoresearch export`): upstream's template with chart, table and share card, served by a small Node server on `127.0.0.1` with live updates as the log changes. It stops on `off`, `clear` and session end.
- **Skills** `autoresearch:autoresearch-create`, `autoresearch:autoresearch-finalize` (with `finalize.sh`) and `autoresearch:autoresearch-hooks` (with nine example hook scripts), adapted to Claude Code.
- Marketplace manifest: install with `/plugin install autoresearch --marketplace victor-falcon/claude-autoresearch`.

### Changed from upstream

- No keyboard shortcuts; every action is a `/autoresearch` subcommand. In the fullscreen dashboard `g` toggles top ↔ bottom (`G` is the same key in Claude Code); `Home`/`End` give the exact ends.
- `run_experiment`'s "Current best" line shows the best kept metric (upstream showed the baseline).
- The finalize skill detects the trunk branch instead of assuming `main`, and asks for the mode to be off first.
- The `idea-rotator.sh` example no longer exits 1 when every idea is checked.
- Reaching `maxIterations` turns the mode off, which also stops the browser dashboard server; `/autoresearch export` brings it back.
