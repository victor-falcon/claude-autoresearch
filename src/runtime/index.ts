import type { EngineInterface } from 'claude-code'

import { reloadExperiment, resetRuntime } from './session.ts'

export * from './fs.ts'
export * from './session.ts'
export * from './state.ts'

/**
 * Shared session bootstrap, run first by the composition root's one
 * `session.start` hook (a module may hook `session.start` only once without a
 * matcher), so every feature's start work sees the reloaded experiment state.
 *
 * It does not touch `enabled` or `decisions`: auto-activation
 * (`shouldAutoActivateAutoresearch`) belongs to the loop module (T4).
 */
export async function startRuntime($: Pick<EngineInterface, 'fs' | 'session' | 'state' | 'ui'>): Promise<void> {
  try {
    await resetRuntime($)
    await reloadExperiment($)
  } catch (error) {
    // Never block the session on a bad config or log; the mod stays idle.
    $.ui.log(`autoresearch: could not load the session state: ${error instanceof Error ? error.message : String(error)}`)
  }
}
