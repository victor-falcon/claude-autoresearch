// init_experiment: start a session (or a new segment) by appending a config
// header to the log (upstream index.ts, `init_experiment`).

import type { EngineInterface } from 'claude-code'

import type { ExperimentState } from '../../types/index.d.ts'
import { readMaxExperiments, resolveWorkDir, validateWorkDir } from '../core/config.ts'
import { serializeConfigEntry } from '../core/jsonl.ts'
import { sessionFilePath } from '../core/paths.ts'
import { withDerivedMetrics } from '../core/state.ts'
import { appendText, fsIo } from '../runtime/fs.ts'
import { getExperiment, setExperiment, setPaths } from '../runtime/state.ts'

type Init$ = Pick<EngineInterface, 'fs' | 'session' | 'state'>

export type InitParams = {
  name: string
  metric_name: string
  metric_unit?: string
  direction?: string
}

/** The new session state: config replaced, a new segment when runs exist. */
export function initializedState(state: ExperimentState, params: InitParams, maxExperiments: number | null): ExperimentState {
  const isReinit = state.results.length > 0
  return withDerivedMetrics({
    ...state,
    name: params.name,
    metricName: params.metric_name,
    metricUnit: params.metric_unit ?? '',
    bestDirection: params.direction === 'lower' || params.direction === 'higher' ? params.direction : state.bestDirection,
    // Keep history for the dashboard; the new segment gets a fresh baseline.
    currentSegment: isReinit ? state.currentSegment + 1 : state.currentSegment,
    secondaryMetrics: [],
    maxExperiments,
  })
}

export async function initExperiment($: Init$, params: InitParams): Promise<string> {
  if (typeof params.name !== 'string' || typeof params.metric_name !== 'string') {
    return '❌ name and metric_name are required strings.'
  }
  const io = fsIo($)
  const cwd = await $.session.cwd()
  const workDirError = await validateWorkDir(io, cwd)
  if (workDirError) return `❌ ${workDirError}`

  const previous = await getExperiment($)
  const isReinit = previous.results.length > 0
  // The config always lives in the session's cwd.
  const state = initializedState(previous, params, await readMaxExperiments(io, cwd))

  const workDir = await resolveWorkDir(io, cwd)
  const logPath = await sessionFilePath(io, workDir, 'log')
  try {
    await appendText($, logPath, serializeConfigEntry(state))
  } catch (error) {
    return `⚠️ Failed to write .auto/log.jsonl: ${error instanceof Error ? error.message : String(error)}`
  }
  await setExperiment($, state)
  await setPaths($, { cwd, workDir, logPath, hasPersistedLog: true, logReadError: null })

  const reinitNote = isReinit ? ' (re-initialized — previous results archived, new baseline needed)' : ''
  const limitNote = state.maxExperiments !== null ? `\nMax iterations: ${state.maxExperiments} (from .auto/config.json)` : ''
  const workDirNote = workDir !== cwd ? `\nWorking directory: ${workDir}` : ''
  return (
    `✅ Experiment initialized: "${state.name}"${reinitNote}\n` +
    `Metric: ${state.metricName} (${state.metricUnit || 'unitless'}, ${state.bestDirection} is better)${limitNote}${workDirNote}\n` +
    'Config written to .auto/log.jsonl. Now run the baseline with run_experiment.'
  )
}
