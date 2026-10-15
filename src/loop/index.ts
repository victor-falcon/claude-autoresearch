import type { EngineInterface, On } from 'claude-code'

import { composeResumeMessage, shouldAutoResumeAfterTurn } from '../core/autoresume.ts'
import { getAutoResume, getEnabled, setRunning, updateAutoResume } from '../runtime/state.ts'
import { hasCompactHook, hasComposeHook, markCompactHook, markComposeHook } from './bypass.ts'
import { modeSection, PROMPT_SECTION_ID } from './prompt.ts'
import { composeRehydrationMessage } from './rehydrate.ts'
import {
  cancelPendingResume,
  ensurePendingResume,
  flushAfterTurn,
  messageOf,
  pausePendingResume,
  setCompacting,
  setRunningTurn,
} from './resume.ts'

export { startLoop } from './mode.ts'

/** Log a hook's failure from its `.catch` handler, where a `$` call may reject. */
function logFailure($: { ui: { log: (text: string) => unknown } }, event: string, message: string | undefined): void {
  try {
    $.ui.log(`autoresearch: ${event} hook failed: ${message ?? 'unknown error'}`)
  } catch {
    // Re-entry: nothing to log with.
  }
}

type Rehydrate$ = Pick<EngineInterface, 'clock' | 'fs' | 'process' | 'prompt' | 'session' | 'state' | 'ui'>

/**
 * After a compaction: while the mode is on, the rehydration prompt (it carries
 * the resume nudge, so it replaces a pending resume); else a pending resume
 * is only rescheduled, and dropped there if the mode is off.
 */
async function resumeAfterCompaction($: Rehydrate$): Promise<void> {
  try {
    const rehydrate = await getEnabled($)
    if (rehydrate) await cancelPendingResume($)
    await ensurePendingResume($, rehydrate, () => composeRehydrationMessage($))
  } catch (error) {
    $.ui.log(`autoresearch: no re-prompt after compaction: ${messageOf(error)}`)
  }
}

/** The transcript's length, to spot a compaction the `session.compact` hook did not see. */
async function messageCount($: Pick<EngineInterface, 'session'>): Promise<number> {
  return (await $.session.messages()).length
}

let lastMessageCount = 0

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
      // An automatic compaction mid-turn shrinks the transcript; when the
      // `session.compact` hook is bypassed, that is the only sign of it.
      const count = await messageCount($)
      const compactedUnseen = !hasCompactHook() && count < lastMessageCount
      lastMessageCount = count
      if (e.reason !== 'answer') {
        // Escape, a refusal or an API error: never re-prompt on its own.
        const hadPending = (await getAutoResume($)).pendingResume !== null
        await cancelPendingResume($)
        if (e.isAborted && (await getEnabled($)) && ((await getAutoResume($)).experimentsThisSession > 0 || hadPending)) {
          $.ui.toast('Autoresearch auto-resume paused — send a message to continue, or /autoresearch off')
        }
      } else if (compactedUnseen) {
        await resumeAfterCompaction($)
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
    markCompactHook()
    // While compacting nothing runs, yet the session is busy: a resume sent
    // now would be queued behind whatever comes next (a `/autoresearch off`).
    setCompacting(true)
    pausePendingResume()
    let result
    try {
      result = await next(e)
    } finally {
      setCompacting(false)
    }
    if (result.messages !== undefined) await resumeAfterCompaction($)
    else await ensurePendingResume($, false, composeResumeMessage)
    lastMessageCount = 0
    return result
  }).catch(($, e, next) => (logFailure($, 'session.compact', next.error.message), next(e)))

  // `/compact` typed while the `session.compact` hook is bypassed.
  on('command.run', { command: 'compact' }, async ($, e, next) => {
    if (hasCompactHook()) return next(e)
    setCompacting(true)
    pausePendingResume()
    try {
      return await next(e)
    } finally {
      setCompacting(false)
      lastMessageCount = await messageCount($).catch(() => 0)
      if (!hasCompactHook()) await resumeAfterCompaction($)
    }
  }).catch(($, e, next) => (logFailure($, 'command.run (compact)', next.error.message), next(e)))

  // Where `prompt.compose` is bypassed, the mode's guidance rides on each of
  // the user's prompts instead (the plugin's own prompts carry it themselves).
  on('prompt.submit', async ($, e, next) => {
    if (hasComposeHook() || e.command || !(await getEnabled($))) return next(e)
    return next({ ...e, context: [...(e.context ?? []), await modeSection($)] })
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    markComposeHook()
    const composed = await next(e)
    if (!(await getEnabled($))) return composed
    const text = await modeSection($)
    return { sections: [...composed.sections, { id: PROMPT_SECTION_ID, text, scope: 'session' as const }] }
  }).catch(($, e, next) => (logFailure($, 'prompt.compose', next.error.message), next(e)))
}
