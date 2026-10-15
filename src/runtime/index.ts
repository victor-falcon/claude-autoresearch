import type { On } from 'claude-code'

import { reloadExperiment, resetRuntime } from './session.ts'

export * from './fs.ts'
export * from './session.ts'
export * from './state.ts'

/**
 * Shared session bootstrap. Registered first, so it is the outermost hook and
 * every feature's `session.start` hook sees the reloaded experiment state.
 */
export function registerRuntime(on: On): void {
  on('session.start', async ($, e, next) => {
    await resetRuntime($)
    await reloadExperiment($)
    return next(e)
  })
}
