import type { EngineInterface, On } from 'claude-code'

import { getEnabled } from '../runtime/state.ts'
import { initExperiment, type InitParams } from './init.ts'
import { logExperiment, type LogParams } from './log.ts'
import { runExperiment, type RunParams } from './run.ts'
import { INACTIVE_MESSAGE, INACTIVE_NOTE, PLUGIN, TOOL_NAMES, TOOL_PATTERN, TOOL_SPECS, toolNameOf, type ToolName } from './specs.ts'

export { fireHook, runHook, steerMessageFor, steerSection } from './hooks.ts'
export type { AfterHookPayload, BeforeHookPayload, HookPayload, HookResult } from './hooks.ts'
export { abortRunningExperiment } from './process.ts'

type Tool$ = Parameters<typeof initExperiment>[0] &
  Parameters<typeof runExperiment>[0] &
  Parameters<typeof logExperiment>[0]

/** The tool's argument fields, without the envelope (`tool`, `tool_use_id`). */
function argsOf<T>(e: Record<string, unknown>): T {
  const { tool: _tool, tool_use_id: _id, ...args } = e
  return args as T
}

// One tool call at a time: each reads, changes and writes the experiment
// state and the working tree, so parallel calls would interleave.
let toolQueue: Promise<unknown> = Promise.resolve()

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const done = toolQueue.then(work, work)
  toolQueue = done.catch(() => undefined)
  return done
}

function runTool($: Tool$, name: ToolName, e: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  switch (name) {
    case 'init_experiment':
      return initExperiment($, argsOf<InitParams>(e))
    case 'run_experiment':
      return runExperiment($, argsOf<RunParams>(e), signal)
    case 'log_experiment':
      return logExperiment($, argsOf<LogParams>(e))
  }
}

/** Register the tools for this session; run from the root's `session.start`. */
export async function startTools($: Pick<EngineInterface, 'tool' | 'ui'>): Promise<void> {
  for (const name of TOOL_NAMES) {
    try {
      await $.tool.register(TOOL_SPECS[name])
    } catch (error) {
      $.ui.log(`autoresearch: could not register ${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * The model-facing tools: init_experiment, run_experiment, log_experiment
 * (schemas in src/core/schemas.ts), listed as `mcp__autoresearch__<name>`.
 *
 * Gating: Claude Code can't unregister a tool, so while `enabled` is false
 * each tool is moved behind ToolSearch with an "inactive" note and every
 * call is refused; while it is true the schemas sit in the prompt's tool
 * list (`isDeferred: false`). Flipping `enabled` (T4) re-describes them.
 *
 * Upstream's init_experiment also switched the mode on and fired before.sh
 * when it was off; here the tools only run while the mode is on, and the
 * `/autoresearch` command fires before.sh at activation.
 */
export function registerTools(on: On): void {
  on('state.set', async ($, e, next) => {
    const result = await next(e)
    // Re-describe the tools so the model's tool list follows the mode.
    if (e.plugin === PLUGIN && e.key === 'enabled' && e.value !== e.previous) $.ui.invalidate('tool.describe')
    return result
  }).catch(($, e, next) => next(e))

  on('tool.describe', { tool: TOOL_PATTERN }, async ($, e, next) => {
    const described = await next(e)
    if (await getEnabled($)) return { description: described.description, isDeferred: false }
    return { description: INACTIVE_NOTE + described.description, isDeferred: true }
  })

  on('tool.call', { tool: TOOL_PATTERN }, async ($, e, next) => {
    const name = toolNameOf(e.tool)
    if (!name) return next(e)
    if (!(await getEnabled($))) return { result: INACTIVE_MESSAGE }
    try {
      return { result: await serialized(() => runTool($, name, e as Record<string, unknown>, next.signal)) }
    } catch (error) {
      return { deny: `${name} failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'The autoresearch tool failed unexpectedly.' }))
}
