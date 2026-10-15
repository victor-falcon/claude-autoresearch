// What the model reads for each tool: upstream's description, with its
// promptSnippet guidelines folded in (Claude Code tools have one description).

import type { ToolSpec } from 'claude-code'

import { INIT_EXPERIMENT_SCHEMA, LOG_EXPERIMENT_SCHEMA, RUN_EXPERIMENT_SCHEMA } from '../core/schemas.ts'
import { EXPERIMENT_MAX_BYTES, EXPERIMENT_MAX_LINES } from './output.ts'

export const PLUGIN = 'autoresearch'

export const TOOL_NAMES = ['init_experiment', 'run_experiment', 'log_experiment'] as const
export type ToolName = (typeof TOOL_NAMES)[number]

const TOOL_PREFIX = `mcp__${PLUGIN}__`

/** Matches the names the model calls the tools by, `mcp__autoresearch__<name>`. */
export const TOOL_PATTERN = new RegExp(`^${TOOL_PREFIX}(${TOOL_NAMES.join('|')})$`)

/** The tool's short name from the name the model called it by; null for another tool. */
export function toolNameOf(qualified: string): ToolName | null {
  return (TOOL_PATTERN.exec(qualified)?.[1] as ToolName | undefined) ?? null
}

function describe(summary: string, guidelines: string[]): string {
  return `${summary}\n\nGuidelines:\n${guidelines.map(line => `- ${line}`).join('\n')}`
}

const INIT_DESCRIPTION = describe(
  'Initialize the experiment session. Call once before the first run_experiment to set the name, primary metric, unit, and direction. Writes the config header to .auto/log.jsonl.',
  [
    'Call init_experiment exactly once at the start of an autoresearch session, before the first run_experiment.',
    'If the session log (.auto/log.jsonl) already exists with a config, do NOT call init_experiment again.',
    'If the optimization target changes (different benchmark, metric, or workload), call init_experiment again to insert a new config header and reset the baseline.',
  ],
)

const RUN_DESCRIPTION = describe(
  `Run a shell command as an experiment. Times wall-clock duration, captures output, detects pass/fail via exit code. Output is truncated to last ${EXPERIMENT_MAX_LINES} lines or ${EXPERIMENT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Use for any autoresearch experiment.`,
  [
    'Use run_experiment instead of Bash when running experiment commands — it handles timing and output capture automatically.',
    'After run_experiment, always call log_experiment to record the result.',
    "If the benchmark script outputs structured METRIC lines (e.g. 'METRIC total_µs=15200'), run_experiment will parse them automatically and suggest exact values for log_experiment. Use these parsed values directly instead of extracting them manually from the output.",
  ],
)

const LOG_DESCRIPTION = describe(
  'Record an experiment result. Tracks metrics, updates the status widget and dashboard. Call after every run_experiment.',
  [
    'Always call log_experiment after run_experiment to record the result.',
    "log_experiment automatically runs git add -A && git commit on 'keep', and auto-reverts code changes on 'discard'/'crash'/'checks_failed' (autoresearch files are preserved). Do NOT commit or revert manually.",
    "Use status 'keep' if the PRIMARY metric improved. 'discard' if worse or unchanged. 'crash' if it failed. Secondary metrics are for monitoring — they almost never affect keep/discard. Only discard a primary improvement if a secondary metric degraded catastrophically, and explain why in the description.",
    'log_experiment reports a confidence score after 3+ runs (best improvement as a multiple of the noise floor). ≥2.0× = likely real, <1.0× = within noise. If confidence is below 1.0×, consider re-running the same experiment to confirm before keeping. The score is advisory — it never auto-discards.',
    "If you discover complex but promising optimizations you won't pursue immediately, append them as bullet points to .auto/ideas.md. Don't let good ideas get lost.",
    'Always include the asi parameter. At minimum: {"hypothesis": "what you tried"}. On discard/crash, also include rollback_reason and next_action_hint. Add any other key/value pairs that capture what you learned — dead ends, surprising findings, error details, bottlenecks. This is the only structured memory that survives reverts.',
    'When log_experiment records a retry of a previously discarded idea after its assumptions changed, set asi.revisits_run to the earlier run number (a positive integer) and explain what changed in description. Omit revisits_run for new ideas and verification reruns.',
  ],
)

export const TOOL_SPECS: Record<ToolName, ToolSpec> = {
  init_experiment: { name: 'init_experiment', description: INIT_DESCRIPTION, inputSchema: INIT_EXPERIMENT_SCHEMA, isDeferred: false },
  run_experiment: { name: 'run_experiment', description: RUN_DESCRIPTION, inputSchema: RUN_EXPERIMENT_SCHEMA, isDeferred: false },
  log_experiment: { name: 'log_experiment', description: LOG_DESCRIPTION, inputSchema: LOG_EXPERIMENT_SCHEMA, isDeferred: false },
}

/** Prefixed to a tool's description while autoresearch mode is off. */
export const INACTIVE_NOTE =
  '[Inactive: autoresearch mode is off. Do not call this tool unless the user starts autoresearch with /autoresearch.]\n\n'

/** The answer to a call made while autoresearch mode is off. */
export const INACTIVE_MESSAGE =
  '❌ Autoresearch mode is off, so the experiment tools are disabled. Ask the user to start it with /autoresearch (e.g. "/autoresearch <goal>") first.'
