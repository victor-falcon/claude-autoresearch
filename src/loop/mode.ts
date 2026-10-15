// Autoresearch mode: activation at session start, explicit on/off decisions,
// and stopping the loop (upstream `reconstructState`'s activation,
// `recordAutoresearchActivation`, `stopAutoresearchLoop`).

import type { EngineInterface } from 'claude-code'

import { shouldAutoActivateAutoresearch } from '../core/autoresume.ts'
import { canonicalDir, sessionWorkDir } from '../runtime/index.ts'
import {
  defaultAutoResume,
  defaultLastRun,
  getDecisions,
  getPaths,
  setAutoResume,
  setEnabled,
  setLastRun,
  setRunning,
  updateDecisions,
} from '../runtime/state.ts'
import { abortRunningExperiment } from '../tools/index.ts'
import { messageOf, pausePendingResume, runningTurn } from './resume.ts'

type Mode$ = Pick<EngineInterface, 'fs' | 'session' | 'state'>

/** Record an explicit `/autoresearch` on/off for the work dir; it wins over auto-activation. */
export async function recordActivation($: Mode$, active: boolean): Promise<void> {
  const key = await canonicalDir($, await sessionWorkDir($))
  await updateDecisions($, decisions => ({ ...decisions, [key]: active }))
}

/**
 * Switch the mode on by itself at session start when the work dir has a
 * persisted log (`shouldAutoActivateAutoresearch`). An explicit decision
 * recorded this session wins, log or not: a reload runs session start again,
 * and a session just started with `/autoresearch <goal>` has no log yet.
 * Runs after `startRuntime`, which reloaded the paths.
 */
export async function startLoop($: Mode$ & Pick<EngineInterface, 'ui'>): Promise<void> {
  try {
    const paths = await getPaths($)
    if (!paths) return
    const cwd = await canonicalDir($, paths.cwd)
    const workDir = await canonicalDir($, paths.workDir)
    const recorded = (await getDecisions($))[workDir]
    if (recorded !== undefined) await setEnabled($, recorded)
    else if (shouldAutoActivateAutoresearch(cwd === workDir, paths.hasPersistedLog)) await setEnabled($, true)
  } catch (error) {
    $.ui.log(`autoresearch: could not decide whether to activate: ${messageOf(error)}`)
  }
}

/** Reset the loop's runtime values: no auto-resume, no run in flight. */
export async function resetLoopRuntime($: Pick<EngineInterface, 'state'>): Promise<void> {
  pausePendingResume()
  await setAutoResume($, defaultAutoResume())
  await setLastRun($, defaultLastRun())
  await setRunning($, null)
}

/**
 * Turn the mode off: record the decision, stop auto-resume, clear the runtime
 * state (the log stays), and abort the experiment and the turn in flight.
 * Resolves whether a turn was running.
 */
export async function stopAutoresearchLoop($: Mode$ & Pick<EngineInterface, 'turn' | 'ui'>): Promise<boolean> {
  await recordActivation($, false)
  await setEnabled($, false)
  await resetLoopRuntime($)
  abortRunningExperiment()
  const turnId = runningTurn()
  if (turnId === null) return false
  await $.turn.abort({ turnId }).catch(error => $.ui.log(`autoresearch: could not abort the turn: ${messageOf(error)}`))
  return true
}
