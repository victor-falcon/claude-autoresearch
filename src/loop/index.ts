import type { On } from 'claude-code'

import { composeResumeMessage, shouldAutoResumeAfterTurn } from '../core/autoresume.ts'
import { getAutoResume, getEnabled, setRunning, updateAutoResume } from '../runtime/state.ts'
import { modeSection, PROMPT_SECTION_ID } from './prompt.ts'
import { composeRehydrationMessage } from './rehydrate.ts'
import { cancelPendingResume, ensurePendingResume, flushAfterTurn, messageOf, pausePendingResume, setRunningTurn } from './resume.ts'

export { startLoop } from './mode.ts'

/** Log a hook's failure from its `.catch` handler, where a `$` call may reject. */
function logFailure($: { ui: { log: (text: string) => unknown } }, event: string, message: string | undefined): void {
  try {
    $.ui.log(`autoresearch: ${event} hook failed: ${message ?? 'unknown error'}`)
  } catch {
    // Re-entry: nothing to log with.
  }
}

/**
 * The continuous loop: auto-resume after each main-loop turn, the re-prompt
 * after a compaction, and the system-prompt section, all while the mode is
 * on. Activation at session start is `startLoop`, run from the composition
 * root's `session.start`.
 */
export function registerLoop(on: On): void {
  // A new turn (the user's, or a resume) holds the pending prompt back and
  // starts a fresh experiment count, as upstream's `agent_start`.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    setRunningTurn(e.turnId)
    pausePendingResume()
    await updateAutoResume($, value => (value.experimentsThisSession === 0 ? value : { ...value, experimentsThisSession: 0 }))
    return next(e)
  }).catch(($, e, next) => (logFailure($, 'turn.start', next.error.message), next(e)))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    setRunningTurn(null)
    flushAfterTurn($)
    try {
      await setRunning($, null)
      if (e.reason !== 'answer') {
        // Escape, a refusal or an API error: never re-prompt on its own.
        const hadPending = (await getAutoResume($)).pendingResume !== null
        await cancelPendingResume($)
        if (e.isAborted && (await getEnabled($)) && ((await getAutoResume($)).experimentsThisSession > 0 || hadPending)) {
          $.ui.toast('Autoresearch auto-resume paused — send a message to continue, or /autoresearch off')
        }
      } else {
        const autoResume = await getAutoResume($)
        const gate = shouldAutoResumeAfterTurn(await getEnabled($), autoResume.experimentsThisSession)
        await ensurePendingResume($, gate, composeResumeMessage)
      }
    } catch (error) {
      $.ui.log(`autoresearch: auto-resume skipped: ${messageOf(error)}`)
    }
    return next(e)
  }).catch(($, e, next) => (logFailure($, 'turn.complete', next.error.message), next(e)))

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    pausePendingResume()
    const result = await next(e)
    try {
      const compacted = result.messages !== undefined
      const gate = compacted && (await getEnabled($))
      await ensurePendingResume($, gate, () => composeRehydrationMessage($))
    } catch (error) {
      $.ui.log(`autoresearch: no re-prompt after compaction: ${messageOf(error)}`)
    }
    return result
  }).catch(($, e, next) => (logFailure($, 'session.compact', next.error.message), next(e)))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await getEnabled($))) return composed
    const text = await modeSection($)
    return { sections: [...composed.sections, { id: PROMPT_SECTION_ID, text, scope: 'session' as const }] }
  }).catch(($, e, next) => (logFailure($, 'prompt.compose', next.error.message), next(e)))
}
