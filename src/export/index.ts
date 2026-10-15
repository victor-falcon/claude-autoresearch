import type { On } from 'claude-code'

import { PLUGIN } from '../tools/specs.ts'
import { stopDashboardServer } from './export.ts'

export { exportDashboard, stopDashboardServer } from './export.ts'

const END_REASONS = ['clear', 'resume', 'logout', 'prompt_input_exit', 'other'] as const

/**
 * The /autoresearch export browser dashboard (`exportDashboard`, called by
 * the command). Its server stops, as upstream's, when the mode is turned off
 * (`/autoresearch off|clear` write `enabled: false`) and when the session
 * ends; unloading the module ends it too. Each hook has its own matcher, so
 * it sits beside the other features' hooks on the same events.
 */
export function registerExport(on: On): void {
  on('state.set', { plugin: PLUGIN, key: 'enabled', value: false }, async ($, e, next) => {
    const result = await next(e)
    stopDashboardServer()
    return result
  }).catch(($, e, next) => next(e))

  on('session.end', { reason: [...END_REASONS] }, async ($, e, next) => {
    stopDashboardServer()
    return next(e)
  })
}
