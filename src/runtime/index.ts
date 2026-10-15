import type { On } from 'claude-code'

import { reloadExperiment, resetRuntime } from './session.ts'

export * from './fs.ts'
export * from './session.ts'
export * from './state.ts'

/**
 * Shared session bootstrap. Registered first, so it is the outermost hook and
 * every feature's `session.start` hook sees the reloaded experiment state.
 *
 * It does not touch `enabled` or `decisions`: auto-activation
 * (`shouldAutoActivateAutoresearch`) belongs to the loop module (T4).
 */
export function registerRuntime(on: On): void {
  on('session.start', async ($, e, next) => {
    try {
      await resetRuntime($)
      await reloadExperiment($)
    } catch (error) {
      // Never block the session on a bad config or log; the mod stays idle.
      $.ui.log(`claude-autoresearch: could not load the session state: ${error instanceof Error ? error.message : String(error)}`)
    }
    return next(e)
  })
}
