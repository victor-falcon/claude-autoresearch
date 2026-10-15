import type { EngineInterface, On } from 'claude-code'

import { exportDashboard } from '../export/export.ts'
import { openDashboard } from '../ui/dashboard.ts'
import { activateAutoresearch, clearAutoresearch, finalizeAutoresearch, turnAutoresearchOff } from './actions.ts'
import {
  ARGUMENT_HINT,
  COMMAND_DESCRIPTION,
  COMMAND_NAME,
  getAutoresearchArgumentCompletions,
  isHelpRequest,
  renderAutoresearchHelp,
} from './subcommands.ts'

/** Register `/autoresearch` for this session; run from the root's `session.start`. */
export async function startCommand($: Pick<EngineInterface, 'command' | 'ui'>): Promise<void> {
  try {
    // Immediate, as pi's commands: `/autoresearch off` must stop a turn in flight.
    await $.command.register({ name: COMMAND_NAME, description: COMMAND_DESCRIPTION, argumentHint: ARGUMENT_HINT, immediate: true })
  } catch (error) {
    $.ui.log(`autoresearch: could not register /${COMMAND_NAME}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Run one `/autoresearch` invocation and answer the text shown to the user. */
export async function dispatchAutoresearch($: EngineInterface, args: string): Promise<string> {
  const trimmedArgs = args.trim()
  const command = trimmedArgs.toLowerCase()

  if (isHelpRequest(command)) return renderAutoresearchHelp()
  if (command === 'off') return turnAutoresearchOff($)
  if (command === 'finalize') return finalizeAutoresearch($)
  if (command === 'export') return exportDashboard($, trimmedArgs)
  if (command === 'dashboard') return openDashboard($, trimmedArgs)
  if (command === 'clear') return clearAutoresearch($)
  return activateAutoresearch($, trimmedArgs)
}

const COMMAND_PREFIX = `/${COMMAND_NAME} `

/** The `/autoresearch` slash command, its subcommands and their completions. */
export function registerCommand(on: On): void {
  on('command.run', { command: COMMAND_NAME }, async ($, e) => ({ text: await dispatchAutoresearch($, e.args) })).catch(
    ($, e, next) => ({ text: `/${COMMAND_NAME} failed: ${next.error.message ?? next.error.kind}` }),
  )

  // Complete the first argument: `/autoresearch o` offers `off`.
  on('prompt.autocomplete', async ($, e, next) => {
    const result = await next(e)
    if (!e.text.startsWith(COMMAND_PREFIX) || e.start !== COMMAND_PREFIX.length) return result
    const completions = getAutoresearchArgumentCompletions(e.token)
    return completions ? { suggestions: [...result.suggestions, ...completions] } : result
  })
}
