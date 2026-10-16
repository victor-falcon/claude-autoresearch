<div align="center">
<img height="120" alt="autoresearch logo" src="assets/logo.webp" />

# claude-autoresearch
### Autonomous experiment loop for Claude Code
**[Install](#install)** · **[Usage](#usage)** · **[How it works](#how-it-works)** · **[Configuration](#configuration-optional)** · **[Changelog](CHANGELOG.md)**

</div>

*Try an idea, measure it, keep what works, discard what doesn't, repeat forever.*

> **Port of [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) by Tobi Lutke and David Cortés** (MIT), from the [pi](https://pi.dev/) coding agent to [Claude Code](https://claude.com/claude-code). All credit for the design, the workflow, the skills and the dashboard goes to them. Upstream is itself inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch).

A Claude Code plugin that gives Claude the tools and workflow to run autonomous optimization loops: try an idea, benchmark it, keep improvements, revert regressions, repeat. It is built as a **mod** (a function-hooks plugin) plus three plugin skills.

Works for any optimization target: test speed, bundle size, LLM training, build times, Lighthouse scores.

---

## Quick start

At the Claude Code prompt:

```text
/plugin install autoresearch --marketplace victor-falcon/claude-autoresearch
```

Then, in the git repository you want to optimize (start from a clean working tree, ideally on a fresh branch or worktree: the loop commits kept experiments and reverts the rest):

```text
/autoresearch optimize unit test runtime, monitor correctness
```

## What's included

| | |
|---|---|
| **Mod** | Three experiment tools, the `/autoresearch` command, the auto-resume loop, a live widget above the prompt, a status line, a fullscreen terminal dashboard and a live browser dashboard |
| **Skills** | Set up a session and start the loop, finalize it into reviewable branches, author iteration hooks |

### Tools

The model calls these as MCP-style tools named `mcp__autoresearch__<name>`. They load up front (non-deferred) while autoresearch mode is on. While it is off they are moved behind tool search, marked inactive, and every call is refused with a message asking for `/autoresearch`.

| Tool | Description |
|------|-------------|
| `mcp__autoresearch__init_experiment` | One-time session config: name, metric, unit, direction |
| `mcp__autoresearch__run_experiment` | Runs a command, times wall-clock duration, captures output, runs `.auto/checks.sh` |
| `mcp__autoresearch__log_experiment` | Records the result, commits on `keep`, reverts on `discard`/`crash`/`checks_failed`, updates the widget and dashboards |

### `/autoresearch` command

| Subcommand | Description |
|------------|-------------|
| `/autoresearch` or `/autoresearch help` | Show help without activating autoresearch mode. `--help` and `-h` work too. |
| `/autoresearch <text>` | Enter autoresearch mode (if it's already on, it says so: just send a message to continue the loop). If `.auto/prompt.md` exists, resumes the loop with `<text>` as context. Otherwise loads the `autoresearch-create` skill to set up a new session. |
| `/autoresearch off` | Leave autoresearch mode. Stops auto-resume, aborts the turn and any experiment in flight, and clears runtime state, but keeps `.auto/log.jsonl` intact. |
| `/autoresearch finalize` | Stop the loop like `off`, then load the `autoresearch-finalize` skill to turn kept experiments into reviewable branches. |
| `/autoresearch clear` | Delete `.auto/log.jsonl`, reset all state, and turn autoresearch mode off. Use this for a clean start. |
| `/autoresearch export` | Open a live dashboard in your browser. It updates as experiments run. |
| `/autoresearch dashboard` | Open the fullscreen scrollable dashboard in the terminal. Scroll with `↑`/`↓`/`j`/`k`, `PageUp`/`PageDown`/`u`/`d`, `Home`/`End`, `g` (toggles top ↔ bottom), close with `Escape` or `q`. |

Subcommands autocomplete: type `/autoresearch ` and pick one from the list, or start typing (`/autoresearch fi` → `finalize`).

**Examples:**

```
/autoresearch optimize unit test runtime, monitor correctness
/autoresearch model training, run 5 minutes of train.py and note the loss ratio as optimization target
/autoresearch export
/autoresearch dashboard
/autoresearch off
/autoresearch finalize
/autoresearch clear
```

There are no keyboard shortcuts: every action is a `/autoresearch` subcommand.

> **Name clash.** If you have a personal command `~/.claude/commands/autoresearch.md` or a personal skill named `autoresearch`, Claude Code refuses the plugin's registration of `/autoresearch` (you'll see `could not register /autoresearch … it is the user's /autoresearch` at startup). Typing `/autoresearch …` still runs the plugin, not your personal command, because the plugin intercepts it; the transcript just echoes `/autoresearch` without the arguments. Rename or remove the personal one to get a clean registration.

### UI

- **Widget above the prompt**: visible while the mode is on. Shows the session name, the runs summary, baseline, progress versus baseline, secondary metrics of the best run, and a results table (commit, metric, secondary columns, status, description). It shrinks to fit narrow or short terminals, and shows a spinner with elapsed time while an experiment runs.
- **Status line**: `🔬 autoresearch · 7 runs · best time_ms 0.71ms (-99.8%) · conf 4.1× · running…`.
- **Confidence score**: after 3+ runs, shows how the best improvement compares to the session noise floor. ≥2.0× (green) = likely real, 1.0–2.0× (yellow) = above noise but marginal, <1.0× (red) = within noise.
- **Fullscreen dashboard**: `/autoresearch dashboard` opens a scrollable pane with every run, including the live running row.
- **Browser dashboard**: `/autoresearch export` serves a page with a chart, the full table and an "Export as image" share card on `127.0.0.1`, updated live as the log grows.

### Skills

Plugin skills are namespaced: the model loads them as `autoresearch:<name>`.

**`autoresearch:autoresearch-create`** asks a few questions (or infers them from context) about your goal, command, metric and files in scope, then creates a branch, writes the session files, runs the baseline and starts the loop immediately.

**`autoresearch:autoresearch-finalize`** turns a noisy autoresearch branch into clean, independent branches, one per logical change, each starting from the merge-base. Groups must not share files, so each branch can be reviewed and merged independently. It needs `git` and `node`.

**`autoresearch:autoresearch-hooks`** *(optional)* helps author `.auto/hooks/before.sh` and `.auto/hooks/after.sh`. It ships nine reference scripts in [`skills/autoresearch-hooks/examples/`](skills/autoresearch-hooks/examples/) (external search, learnings journal, native notifications, anti-thrash, idea rotation, and more). The skill handles the contract, you pick the inspiration.

All session files live in a single `.auto/` folder at the working-directory root: one folder to preserve across reverts, gitignore, and clean up. Legacy flat `autoresearch.*` files are still read for in-flight sessions.

| File | Purpose |
|------|---------|
| `.auto/prompt.md` | Session document: objective, metrics, files in scope, what's been tried. A fresh agent can resume from this alone. |
| `.auto/measure.sh` | Benchmark script: pre-checks, runs the workload, outputs `METRIC name=number` lines. |
| `.auto/log.jsonl` | Append-only log of every run (written by the tools). |
| `.auto/checks.sh` | *(optional)* Backpressure checks: tests, types, lint. Runs after each passing benchmark. Failures block `keep`. |
| `.auto/ideas.md` | *(optional)* Backlog of ideas still to try. Read back after a compaction. |
| `.auto/config.json` | *(optional)* `workingDir` and `maxIterations`, see [Configuration](#configuration-optional). |
| `.auto/hooks/` | *(optional)* Executable scripts (`before.sh`, `after.sh`) that fire around iterations. Their stdout reaches the agent. |

### Compatible with pi-autoresearch

The `.auto/` layout, the file names and the JSONL entry shapes are the same as upstream's, so a session can move between pi and Claude Code: start it in one, continue it in the other. Hook scripts written for pi-autoresearch work unchanged.

---

## Install

**Requirements**

- **Claude Code 2.1.300 or newer** (check with `claude --version`). The mod API this plugin uses is in early access; CI pins and tests against `2.1.300`. On an older build the plugin doesn't load: there is no widget, and `/autoresearch` and the `mcp__autoresearch__*` tools are missing.
- `git`, `bash`, and `node` on `PATH` (plus `jq` if you use the example hook scripts). Node runs the browser dashboard server of `/autoresearch export` (any current LTS) and the `finalize.sh` script.

**From the Claude Code prompt**

```text
/plugin install autoresearch --marketplace victor-falcon/claude-autoresearch
```

**From a shell**

```bash
claude plugin install autoresearch --marketplace victor-falcon/claude-autoresearch
```

**In the desktop app**

The desktop app's local Code sessions share your Claude Code settings, so the simplest route is to run the shell command above once. Then, in a Code session, check it under **+ › Plugins › Manage plugins**. If the marketplace is already added, you can also install from **+ › Plugins › Add plugin** and pick `autoresearch`. Plugins aren't available in cloud sessions.

**For development** (load a local checkout for one session, no install):

```bash
git clone https://github.com/victor-falcon/claude-autoresearch
claude --plugin-dir ./claude-autoresearch
```

---

## Usage

### 1. Start autoresearch

```text
/autoresearch optimize unit test runtime, monitor correctness
```

This activates autoresearch mode and makes the experiment tools available. If `.auto/prompt.md` does not exist, it also loads the `autoresearch-create` skill. Loading the skill directly (`autoresearch:autoresearch-create`) does not activate the mode, so the tools stay inactive and the skill asks you to run `/autoresearch <goal>`.

The agent asks about your goal, command, metric and files in scope, or infers them from context. It then creates a branch, writes `.auto/prompt.md` and `.auto/measure.sh` (and `.auto/checks.sh` when correctness matters), runs the baseline, and starts looping immediately.

The mode never turns on by itself: opening Claude Code in a directory that already has a session log leaves it off, with no widget and the tools inactive. Run `/autoresearch <text>` (for example `/autoresearch continue the loop`) to pick the session up again.

### 2. The loop

The agent runs autonomously: edit → `run_experiment` → `log_experiment` → keep (commit) or revert → repeat. When a turn ends after logging an experiment, the plugin sends the next "run the next iteration" prompt on its own. It keeps going until you interrupt it, `maxIterations` is reached, or one of the [auto-resume guards](#long-running-loops-and-compaction) trips.

Every result is appended to `.auto/log.jsonl` in your project, one line per run. This means:

- **Survives restarts**: the agent can resume a session by reading the file.
- **Survives context resets**: `.auto/prompt.md` captures what's been tried, so a fresh agent has full context.
- **Human readable**: open it anytime to see the full history.
- **Branch-aware**: each branch has its own session.

### 3. Finalize into reviewable branches

```
/autoresearch finalize
```

This stops the loop (aborting a run in progress) and loads the `autoresearch-finalize` skill. Loading the skill directly leaves autoresearch mode on; the skill then asks you to run `/autoresearch off` first, so the loop doesn't start new experiments while it waits for your approval.

The agent reads `.auto/log.jsonl`, groups kept experiments into logical changesets, proposes the grouping for your approval, then creates independent branches from the merge-base. Each commit includes the metric improvement in its message.

### 4. Monitor progress

- **Widget and status line**: always visible while the mode is on.
- **`/autoresearch dashboard`**: fullscreen scrollable dashboard in the terminal.
- **`/autoresearch export`**: live browser dashboard with chart and share card.
- **`Escape`**: interrupt anytime. The auto-resume loop pauses (the mode stays on); send a message to continue.

---

## Example domains

| Domain | Metric | Command |
|--------|--------|---------|
| Test speed | seconds ↓ | `pnpm test` |
| Bundle size | KB ↓ | `pnpm build && du -sb dist` |
| LLM training | val_bpb ↓ | `uv run train.py` |
| Build speed | seconds ↓ | `pnpm build` |
| Lighthouse | perf score ↑ | `lighthouse http://localhost:3000 --output=json` |

---

## How it works

The **mod** is domain-agnostic infrastructure. The **skill** encodes domain knowledge. This separation means one plugin serves unlimited domains.

```
┌──────────────────────┐     ┌──────────────────────────┐
│  Mod (global)        │     │  Session (per-domain)     │
│                      │     │                           │
│  run_experiment      │◄────│  command: pnpm test       │
│  log_experiment      │     │  metric: seconds (lower)  │
│  widget + dashboards │     │  scope: vitest configs    │
│  auto-resume loop    │     │  ideas: pool, parallel…   │
└──────────────────────┘     └──────────────────────────┘
```

Two files keep the session alive across restarts and context resets:

```
.auto/log.jsonl   — append-only log of every run (metric, status, commit, description)
.auto/prompt.md   — living document: objective, what's been tried, dead ends, key wins
```

A fresh agent with no memory can read these two files and continue exactly where the previous session left off.

While the mode is on, the plugin adds an "Autoresearch Mode (ACTIVE)" section to the system prompt with the rules path and guardrails. Where an organization's managed settings block a user plugin's system-prompt and compaction hooks, the plugin detects it and sends the same guidance with your prompts and its own loop prompts instead.

---

## Configuration (optional)

Create `.auto/config.json` in the directory you start Claude Code in:

```json
{
  "workingDir": "/path/to/project",
  "maxIterations": 50
}
```

| Field | Type | Description |
|-------|------|-------------|
| `workingDir` | string | Override the directory for all autoresearch operations: file I/O, command execution, and git. Absolute, or relative to the Claude Code session's working directory. The config file itself always stays under the session's working directory. Fails if the directory doesn't exist. |
| `maxIterations` | number | Maximum experiments before auto-stopping. The agent is told to stop and the mode turns off. To go on, raise the limit and run `/autoresearch <text>` again; the agent then starts a new segment with `init_experiment`. |

### Long-running loops and compaction

The loop is designed to run unattended across context limits. When Claude Code compacts the conversation (automatically or with `/compact`) while the mode is on, the plugin sends one rehydration prompt built from the source of truth: the rules in `.auto/prompt.md`, the ideas backlog, the session and its recent runs from `.auto/log.jsonl`, and `git log`, followed by the "continue" nudge. All progress is persisted in those files, so the post-compaction turn doesn't rely on whatever survived the summary.

Auto-resume has guards, ported from upstream: it stops after 200 auto-resumed turns or more than 20 consecutive discards or crashes (with a notice), and it never re-prompts after `Escape`, a refusal or an API error.

---

## Confidence scoring

After 3+ experiments in a session, the plugin computes a **confidence score**: how the best improvement compares to the session's noise floor. This helps distinguish real gains from benchmark jitter, especially on noisy signals like ML training, Lighthouse scores, or flaky benchmarks.

**How it works:**

- Uses the [Median Absolute Deviation (MAD)](https://en.wikipedia.org/wiki/Median_absolute_deviation) of all metric values in the current segment as a robust noise estimator.
- Confidence = `|best_improvement| / MAD`. A score of 2.0× means the best improvement is twice the noise floor.
- Shown in the widget, the status line, both dashboards, and the `log_experiment` output.
- Persisted to `.auto/log.jsonl` on each result for post-hoc analysis.
- **Advisory only**: it never auto-discards. The agent is guided to re-run experiments when confidence is low, but the keep/discard decision stays with the agent.

| Confidence | Color | Meaning |
|-----------|-------|---------|
| ≥ 2.0× | 🟢 green | Improvement is likely real |
| 1.0–2.0× | 🟡 yellow | Above noise but marginal |
| < 1.0× | 🔴 red | Within noise; consider re-running to confirm |

---

## Backpressure checks (optional)

Create `.auto/checks.sh` to run correctness checks (tests, types, lint) after every passing benchmark. This ensures optimizations don't break things.

```bash
#!/bin/bash
set -euo pipefail
pnpm test --run
pnpm typecheck
```

**How it works:**

- If the file doesn't exist, the loop behaves exactly as without it.
- If it exists, it runs automatically after every benchmark that exits 0.
- Checks execution time does **not** affect the primary metric.
- If checks fail, the experiment is logged as `checks_failed` (same behavior as a crash: no commit, changes reverted).
- The `checks_failed` status is shown separately in the dashboards, so you can tell correctness failures from benchmark crashes.
- Checks have their own timeout (default 300 s, set with `checks_timeout_seconds` on `run_experiment`). The benchmark's timeout is `timeout_seconds` (default 600 s); on timeout the whole process tree is killed.

---

## Hooks (optional)

Drop executable scripts in `.auto/hooks/` to run code at iteration boundaries. Hooks are **transparent to the agent**: the agent calls tools and sees results; hooks run alongside without any agent-facing surface.

- `.auto/hooks/before.sh` fires before every iteration: at `/autoresearch` activation and at the end of every `log_experiment`, after `after.sh`. Use it for prospective work: fetch research, prime context for the next attempt.
- `.auto/hooks/after.sh` fires at the end of every `log_experiment`. Use it for retrospective work: annotate learnings, send notifications.

**Contract** (identical to pi-autoresearch's):

- Must be executable (`chmod +x`). Preserved on revert: the entire `.auto/` folder survives (as do legacy `autoresearch.*` artefacts).
- **Stdin**: a JSON object on a single line. Its shape depends on the stage (see below). Extract fields with `jq` (the example scripts need it).
- **Stdout** reaches the agent, capped at 8 KB: appended to the `log_experiment` result, or, for the activation `before.sh`, prepended to the resume prompt when `.auto/prompt.md` exists (a brand-new session's kickoff only loads the create skill). Empty stdout = silent. (In pi this was a "steer message".)
- Non-zero exit or a >30 s timeout reports an error to the agent the same way.
- Each fire appends a `{"type":"hook",…}` entry to `.auto/log.jsonl` for observability.

**`before.sh` stdin** (on fresh activation `last_run` is `null`):

```json
{
  "event": "before",
  "cwd": "/path/to/workdir",
  "next_run": 6,
  "last_run": {
    "run": 5, "status": "discard", "metric": 42.1,
    "description": "…",
    "asi": { "hypothesis": "…", "next_focus": "…" }
  },
  "session": {
    "metric_name": "total_ms", "metric_unit": "ms", "direction": "lower",
    "baseline_metric": 40.7, "best_metric": 33.5,
    "run_count": 5, "goal": "optimize sort speed"
  }
}
```

**`after.sh` stdin:**

```json
{
  "event": "after",
  "cwd": "/path/to/workdir",
  "run_entry": {
    "run": 6, "status": "discard", "metric": 38.9,
    "description": "…",
    "asi": { "hypothesis": "…", "learned": "…" }
  },
  "session": { "metric_name": "total_ms", "direction": "lower", "baseline_metric": 40.7, "best_metric": 33.5, "run_count": 6, "goal": "…" }
}
```

**Agent signal.** The agent writes `description` and `asi.*` fields in its `log_experiment` calls for its own future-self reasoning. The hook opportunistically mines whichever fields the agent naturally uses: `asi.hypothesis`, `asi.next_focus`, `description`, etc. There is no dedicated "hook input" field; the agent is unaware the hook exists.

**Examples.** Reference scripts for both stages live in [`skills/autoresearch-hooks/examples/`](skills/autoresearch-hooks/examples/): external search, qmd document search, persistent learnings, native notifications, git tagging, anti-thrash, idea rotator, hypothesis reflection (asks `claude -p --model haiku`), context rotation. Copy one to your session's `.auto/hooks/` directory, adapt, `chmod +x`.

---

## Security and trust

Claude Code plugins run with your full user permissions. Review this repository before installing it, and run autoresearch in a dedicated branch or worktree with a clean working tree.

Autoresearch intentionally edits files, creates and reverts commits, and executes the commands in `.auto/measure.sh`, `.auto/checks.sh`, and `.auto/hooks/`. Treat those files as executable code: review them before each session, keep credentials and sensitive files out of scope, and use a sandbox or restricted environment for untrusted projects.

On `keep` it commits everything in the working tree (`git add -A`). On `discard`, `crash` and `checks_failed` it restores tracked files to the last commit and **deletes untracked files** that aren't git-ignored (except `.auto/` and legacy `autoresearch.*` files), so uncommitted work outside the session is lost.

The browser dashboard server listens on `127.0.0.1` only, serves only the page, the session log and its live-update stream, rejects requests whose `Host` isn't loopback, and stops on `/autoresearch off`, `/autoresearch clear` and when the session ends.

For reproducible installs, review and pin a commit or tag of this repository.

## Controlling costs

Autoresearch loops run autonomously and can burn through tokens. Ways to cap spend:

- **Your plan or API limits**: watch Claude Code's usage, and set spend limits for API keys in the Claude Console.
- **`maxIterations`**: cap experiments per session in `.auto/config.json`:
   ```json
   {
     "maxIterations": 30
   }
   ```
- **A cheaper model** for long loops, e.g. `/model sonnet`.
- **`/autoresearch off`** or `Escape` stops the loop at any time.

---

## Development

Requirements: Node 22.18+ and Claude Code on `PATH` (no API key needed for any of these).

```sh
npm install
npm run types      # lay the mod API types (.claude-plugin/types/, git-ignored; needed before typecheck)
npm run typecheck  # tsc over the mod and over the pure core
npm test           # core + dashboard server tests (node --test), finalize.sh tests, mod tests (claude plugin test)
npm run validate   # claude plugin validate .
```

To try the mod in a session: `claude --plugin-dir .`

Layout: `hooks/register.tsx` is a thin composition root that calls one `register*` per feature folder under `src/` (`tools`, `command`, `loop`, `ui`, `export`) and owns the single `session.start` hook; `src/runtime/` holds the shared `$.state`/`$.fs` glue; `src/core/` is the pure, unit-tested logic ported from pi-autoresearch; `types/index.d.ts` is the `$.state` contract; `skills/` holds the three plugin skills; `assets/` holds the browser dashboard template and its Node server.

## Support

If this plugin saves you time, you can support its development through [GitHub Sponsors](https://github.com/sponsors/victor-falcon).

## License

MIT, see [LICENSE](LICENSE). Original work © Tobi Lutke, David Cortés ([pi-autoresearch](https://github.com/davebcn87/pi-autoresearch)); Claude Code port by Víctor Falcón.
