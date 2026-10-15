// Auto-resume: after a main-loop turn ends while the mode is on, wait a short
// settle window and send the model a prompt to run the next iteration
// (upstream `ensurePendingResume` / `sendPendingResumeIfReady`).
//
// The pending prompt itself lives in `$.state` (`autoResume.pendingResume`);
// the timer and the running turn's id are this module's.

import type { EngineInterface, Timer } from 'claude-code'

import { autoResumeStopReasonFor } from '../core/autoresume.ts'
import { getAutoResume, getEnabled, getExperiment, updateAutoResume } from '../runtime/state.ts'

export type Resume$ = Pick<EngineInterface, 'clock' | 'prompt' | 'state' | 'ui'>

/** How long the agent must stay settled before a resume prompt goes out. */
export const SETTLED_WINDOW_MS = 800

let timer: Timer | null = null
let runningTurnId: string | null = null
/** Prompts held until the running turn ends (an aborted turn never drains a queue). */
let afterTurn: string[] = []
let compacting = false

/** The main loop's turn in flight (its `turn.start` id), or null when idle. */
export function runningTurn(): string | null {
  return runningTurnId
}

export function setRunningTurn(turnId: string | null): void {
  runningTurnId = turnId
}

/** Set while the conversation is being compacted; its end reschedules. */
export function setCompacting(value: boolean): void {
  compacting = value
}

function isBusy(): boolean {
  return runningTurnId !== null || compacting
}

function submitSoon($: Pick<EngineInterface, 'clock' | 'prompt' | 'ui'>, text: string): void {
  // A timer, not the calling hook: a `command.run` hook may not submit (the
  // turn would wait on it). The engine queues the prompt until it is idle.
  $.clock.after(0, () => {
    $.prompt.submit({ text }).catch(error => $.ui.log(`autoresearch: could not send the prompt: ${messageOf(error)}`))
  })
}

/** Send the model a prompt once the session is idle: after the running turn, if any. */
export function submitWhenIdle($: Pick<EngineInterface, 'clock' | 'prompt' | 'ui'>, text: string): void {
  if (runningTurnId !== null) afterTurn.push(text)
  else submitSoon($, text)
}

/** Send what waited for the turn that just ended. */
export function flushAfterTurn($: Pick<EngineInterface, 'clock' | 'prompt' | 'ui'>): void {
  const waiting = afterTurn
  afterTurn = []
  for (const text of waiting) submitSoon($, text)
}

/** Stop the timer, keeping the pending prompt for a later reschedule. */
export function pausePendingResume(): void {
  timer?.cancel()
  timer = null
}

/** Drop the pending prompt and its timer. */
export async function cancelPendingResume($: Pick<EngineInterface, 'state'>): Promise<void> {
  pausePendingResume()
  await updateAutoResume($, value => (value.pendingResume ? { ...value, pendingResume: null } : value))
}

async function stopReason($: Resume$): Promise<string | null> {
  const autoResume = await getAutoResume($)
  return autoResumeStopReasonFor({ autoResumeTurns: autoResume.turns, state: await getExperiment($) })
}

async function schedulePendingResume($: Resume$, message: string): Promise<void> {
  pausePendingResume()
  const dueAt = (await $.clock.now()) + SETTLED_WINDOW_MS
  await updateAutoResume($, value => ({ ...value, pendingResume: { message, dueAt } }))
  timer = $.clock.after(SETTLED_WINDOW_MS, () => {
    timer = null
    sendPendingResumeIfReady($).catch(error => $.ui.log(`autoresearch: auto-resume failed: ${messageOf(error)}`))
  })
}

/** Send the pending prompt, unless the mode went off, a turn runs or a guard stops it. */
export async function sendPendingResumeIfReady($: Resume$): Promise<void> {
  const pending = (await getAutoResume($)).pendingResume
  if (!pending) return
  if (!(await getEnabled($))) {
    await cancelPendingResume($)
    return
  }
  // A turn or a compaction is running: its end reschedules the pending prompt.
  if (isBusy()) return
  const reason = await stopReason($)
  if (reason !== null) {
    await cancelPendingResume($)
    $.ui.toast(reason)
    return
  }
  // A turn may have started during the reads above: its end reschedules.
  if (isBusy()) return
  await updateAutoResume($, value => ({ ...value, pendingResume: null, turns: value.turns + 1 }))
  // Queued by the engine until the session is idle; resolves as its turn starts.
  $.prompt.submit({ text: pending.message }).catch(error => $.ui.log(`autoresearch: could not send the resume prompt: ${messageOf(error)}`))
}

/**
 * Schedule a resume prompt: an already pending one is rescheduled as is;
 * otherwise, when `gate` allows and no guard stops it, `compose()`'s.
 */
export async function ensurePendingResume($: Resume$, gate: boolean, compose: () => string | Promise<string>): Promise<void> {
  const pending = (await getAutoResume($)).pendingResume
  if (pending) {
    await schedulePendingResume($, pending.message)
    return
  }
  if (!gate) return
  const reason = await stopReason($)
  if (reason !== null) {
    $.ui.toast(reason)
    return
  }
  await schedulePendingResume($, await compose())
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
