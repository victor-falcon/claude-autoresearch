// What each /autoresearch subcommand does (upstream `registerCommand("autoresearch")`,
// `turnAutoresearchOff`, `finalizeAutoresearch`). Each answers the text shown
// to the user, where upstream called `ctx.ui.notify`.

import type { EngineInterface } from 'claude-code'

import { BENCHMARK_GUARDRAIL } from '../core/autoresume.ts'
import { lastRunEntry } from '../core/jsonl.ts'
import { sessionFileCandidates } from '../core/paths.ts'
import { relative } from '../core/pathutil.ts'
import { buildSessionSnapshot } from '../core/state.ts'
import { recordActivation, resetLoopRuntime, stopAutoresearchLoop } from '../loop/mode.ts'
import { withModeGuidance } from '../loop/prompt.ts'
import { submitWhenIdle } from '../loop/resume.ts'
import { reloadExperiment, sessionFile, sessionWorkDir } from '../runtime/index.ts'
import { getEnabled, getExperiment, setEnabled, updateAutoResume } from '../runtime/state.ts'
import { abortRunningExperiment, fireHook } from '../tools/index.ts'

const CREATE_SKILL = 'autoresearch:autoresearch-create'
const FINALIZE_SKILL = 'autoresearch:autoresearch-finalize'

/** The prompt that has the model load a plugin skill (pi's `/skill:<name> <args>`). */
export function skillKickoff(skill: string, args = ''): string {
  const goal = args.trim()
  return [`Use the Skill tool to load the \`${skill}\` skill and follow it.`, goal ? `Arguments: ${goal}` : '']
    .filter(Boolean)
    .join('\n')
}

/** `/autoresearch off`: stop the loop, keep the log. */
export async function turnAutoresearchOff($: EngineInterface): Promise<string> {
  const wasRunning = await stopAutoresearchLoop($)
  return wasRunning ? 'Autoresearch mode OFF — aborting current run' : 'Autoresearch mode OFF'
}

async function hasLoggedExperiment($: EngineInterface): Promise<boolean> {
  try {
    const logPath = await sessionFile($, 'log')
    if (!(await $.fs.exists(logPath))) return false
    return lastRunEntry(await $.fs.read(logPath)) !== null
  } catch {
    return false
  }
}

/** `/autoresearch finalize`: stop the loop, then have the model run the finalize skill. */
export async function finalizeAutoresearch($: EngineInterface): Promise<string> {
  if (!(await hasLoggedExperiment($))) {
    return "No logged experiments to finalize — use '/autoresearch <goal>' to start a session"
  }
  if (await getEnabled($)) await stopAutoresearchLoop($)
  submitWhenIdle($, skillKickoff(FINALIZE_SKILL))
  return 'Loading autoresearch-finalize skill'
}

/** `/autoresearch clear`: delete the session log, reset all state, turn the mode off. */
export async function clearAutoresearch($: EngineInterface): Promise<string> {
  const workDir = await sessionWorkDir($)
  await recordActivation($, false)
  await setEnabled($, false)
  await resetLoopRuntime($)
  // A run in flight would log into the log about to be deleted.
  abortRunningExperiment()

  const deleted: string[] = []
  let failure: string | null = null
  for (const logPath of Object.values(sessionFileCandidates(workDir, 'log'))) {
    if (!(await $.fs.exists(logPath))) continue
    const name = relative(workDir, logPath) || logPath
    // $.fs has no delete.
    const removed = await $.process.run(['rm', '-f', '--', logPath]).catch((error: unknown) => ({ exitCode: 1, stderr: String(error) }))
    if (removed.exitCode !== 0) {
      failure = `Failed to delete ${name}: ${removed.stderr.trim()}`
      break
    }
    deleted.push(name)
  }
  await reloadExperiment($)
  if (failure) return failure
  return deleted.length > 0
    ? `Deleted ${deleted.join(', ')} and turned autoresearch mode OFF`
    : 'No session log found. Autoresearch mode OFF'
}

/**
 * `/autoresearch <text>`: switch the mode on and start the loop: resume it
 * with `<text>` as context when `.auto/prompt.md` exists, else have the model
 * set up a new session with the create skill. before.sh fires at activation.
 */
export async function activateAutoresearch($: EngineInterface, args: string): Promise<string> {
  if (await getEnabled($)) return "Autoresearch already active — use '/autoresearch off' to stop first"

  const workDir = await sessionWorkDir($)
  await recordActivation($, true)
  await setEnabled($, true)
  await updateAutoResume($, value => ({ ...value, turns: 0 }))

  const rulesLoaded = await $.fs.exists(await sessionFile($, 'prompt'))
  const goal = `${args} ${BENCHMARK_GUARDRAIL}`.replace(/\s+/g, ' ').trim()
  const kickoff = rulesLoaded ? `Autoresearch mode active. ${goal}` : skillKickoff(CREATE_SKILL, goal)

  const state = await getExperiment($)
  const logPath = await sessionFile($, 'log')
  const log = (await $.fs.exists(logPath)) ? await $.fs.read(logPath).catch(() => '') : ''
  const activationSteer = await fireHook($, {
    event: 'before',
    cwd: workDir,
    next_run: state.results.length + 1,
    last_run: lastRunEntry(log) as Record<string, unknown> | null,
    session: buildSessionSnapshot(state),
  }).catch(() => null)

  // Upstream prepends the hook's output only when prompt.md exists, so a new
  // session's kickoff stays the skill invocation.
  const message = activationSteer && rulesLoaded ? `${activationSteer}\n\n${kickoff}` : kickoff
  submitWhenIdle($, await withModeGuidance($, message))

  return rulesLoaded
    ? 'Autoresearch mode ON — rules loaded from .auto/prompt.md'
    : 'Autoresearch mode ON — no .auto/prompt.md found, loading autoresearch-create skill'
}
