// log_experiment: record a result, commit or revert, append it to the log,
// fire the after/before hooks and enforce maxIterations (upstream index.ts,
// `log_experiment`).

import type { EngineInterface } from 'claude-code'

import type { ExperimentAsi, ExperimentResult, ExperimentState, ExperimentStatus } from '../../types/index.d.ts'
import { resolveWorkDir, validateWorkDir } from '../core/config.ts'
import { registerSecondaryMetrics, serializeRunEntry } from '../core/jsonl.ts'
import { describeConfidence, findBaselineSecondary, formatNum } from '../core/metrics.ts'
import { sessionFilePath } from '../core/paths.ts'
import { buildSessionSnapshot, isIterationLimitReached, segmentRunCount, withDerivedMetrics } from '../core/state.ts'
import { appendText, canonicalDir, fsIo } from '../runtime/fs.ts'
import {
  defaultLastRun,
  getEnabled,
  getExperiment,
  getLastRun,
  setEnabled,
  setExperiment,
  setLastRun,
  setRunning,
  updateAutoResume,
  updateDecisions,
} from '../runtime/state.ts'
import { commitAll, commitMessage, revertChanges } from './git.ts'
import { fireHook, steerSection } from './hooks.ts'

type Log$ = Pick<EngineInterface, 'fs' | 'session' | 'state' | 'process' | 'clock'>

export type LogParams = {
  commit: string
  metric: number
  status: ExperimentStatus
  description: string
  metrics?: Record<string, number>
  force?: boolean
  asi?: ExperimentAsi
}

const STATUSES: readonly ExperimentStatus[] = ['keep', 'discard', 'crash', 'checks_failed']

export const REVISIT_NUDGE =
  "Before choosing the next experiment, consider whether this result or discovery invalidates a previous discard's rollback reason. If so, name what changed and weigh a targeted retry against other candidates. Otherwise, move on. Don't revive a discarded idea without a changed assumption. Verification reruns to resolve measurement noise are separate."

/** Why the secondary metrics can't be logged as given; null when they can. */
export function secondaryMetricsError(state: ExperimentState, metrics: Record<string, number>, force: boolean): string | null {
  if (state.secondaryMetrics.length === 0) return null
  const knownNames = new Set(state.secondaryMetrics.map(metric => metric.name))
  const providedNames = new Set(Object.keys(metrics))

  const missing = [...knownNames].filter(name => !providedNames.has(name))
  if (missing.length > 0) {
    return (
      `❌ Missing secondary metrics: ${missing.join(', ')}\n\n` +
      `You must provide all previously tracked metrics. Expected: ${[...knownNames].join(', ')}\n` +
      `Got: ${[...providedNames].join(', ') || '(none)'}\n\n` +
      `Fix: include ${missing.map(name => `"${name}": <value>`).join(', ')} in the metrics parameter.`
    )
  }

  const added = [...providedNames].filter(name => !knownNames.has(name))
  if (added.length > 0 && !force) {
    return (
      `❌ New secondary metric${added.length > 1 ? 's' : ''} not previously tracked: ${added.join(', ')}\n\n` +
      `Existing metrics: ${[...knownNames].join(', ')}\n\n` +
      'If this metric has proven very valuable to watch, call log_experiment again with force: true to add it. Otherwise, remove it from the metrics parameter.'
    )
  }
  return null
}

/** The state with `result` added, and the result with the session confidence. */
export function withResult(state: ExperimentState, result: ExperimentResult): { state: ExperimentState; result: ExperimentResult } {
  const secondaryMetrics = state.secondaryMetrics.map(metric => ({ ...metric }))
  registerSecondaryMetrics(secondaryMetrics, result.metrics)
  const next = withDerivedMetrics({ ...state, results: [...state.results, result], secondaryMetrics })
  const logged = { ...result, confidence: next.confidence }
  return { state: withLastResult(next, logged), result: logged }
}

/** The state with its last result replaced (e.g. by the committed hash). */
function withLastResult(state: ExperimentState, result: ExperimentResult): ExperimentState {
  return { ...state, results: [...state.results.slice(0, -1), result] }
}

/** The result summary upstream shows, before the git and limit notes. */
export function resultSummary(state: ExperimentState, result: ExperimentResult): string {
  const segmentCount = segmentRunCount(state)
  const baseline = state.baselineMetric
  let text = `Logged #${state.results.length}: ${result.status} — ${result.description}`

  if (baseline !== null) {
    text += `\nBaseline ${state.metricName}: ${formatNum(baseline, state.metricUnit)}`
    if (segmentCount > 1 && result.status === 'keep' && result.metric > 0) {
      const delta = result.metric - baseline
      const pct = ((delta / baseline) * 100).toFixed(1)
      text += ` | this: ${formatNum(result.metric, state.metricUnit)} (${delta > 0 ? '+' : ''}${pct}%)`
    }
  }

  if (Object.keys(result.metrics).length > 0) {
    const baselines = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics)
    const parts: string[] = []
    for (const [name, value] of Object.entries(result.metrics)) {
      const unit = state.secondaryMetrics.find(metric => metric.name === name)?.unit ?? ''
      let part = `${name}: ${formatNum(value, unit)}`
      const base = baselines[name]
      if (base !== undefined && state.results.length > 1 && base !== 0) {
        const delta = value - base
        part += ` (${delta > 0 ? '+' : ''}${((delta / base) * 100).toFixed(1)}%)`
      }
      parts.push(part)
    }
    text += `\nSecondary: ${parts.join('  ')}`
  }

  if (result.asi) {
    const parts = Object.entries(result.asi).map(([key, value]) => {
      const shown = typeof value === 'string' ? value : JSON.stringify(value)
      return `${key}: ${shown.length > 80 ? shown.slice(0, 77) + '…' : shown}`
    })
    if (parts.length > 0) text += `\n📋 ASI: ${parts.join(' | ')}`
  }

  if (state.confidence !== null) text += `\n${describeConfidence(state.confidence)}`

  text += `\n(${segmentCount} experiments`
  if (state.maxExperiments !== null) text += ` / ${state.maxExperiments} max`
  text += ')'
  return text
}

/** Why the arguments can't be logged; null when they can. */
function paramsError(params: LogParams): string | null {
  if (!STATUSES.includes(params.status)) {
    return `❌ Invalid status "${String(params.status)}". Use one of: ${STATUSES.join(', ')}.`
  }
  if (typeof params.metric !== 'number' || !Number.isFinite(params.metric)) {
    return '❌ metric must be a finite number (use 0 for crashes).'
  }
  if (typeof params.description !== 'string') return '❌ description must be a string.'
  const metrics = Object.entries(params.metrics ?? {})
  const invalid = metrics.filter(([, value]) => typeof value !== 'number' || !Number.isFinite(value))
  if (invalid.length > 0) return `❌ Secondary metrics must be finite numbers: ${invalid.map(([name]) => name).join(', ')}`
  return null
}

export async function logExperiment($: Log$, params: LogParams): Promise<string> {
  const invalid = paramsError(params)
  if (invalid) return invalid
  const io = fsIo($)
  const cwd = await $.session.cwd()
  const workDirError = await validateWorkDir(io, cwd)
  if (workDirError) return `❌ ${workDirError}`
  const workDir = await resolveWorkDir(io, cwd)
  const secondary = params.metrics ?? {}

  // A run whose checks failed can't be kept.
  const lastRun = await getLastRun($)
  if (params.status === 'keep' && lastRun.checks && !lastRun.checks.pass) {
    return (
      `❌ Cannot keep — .auto/checks.sh failed.\n\n${lastRun.checks.output.slice(-500)}\n\n` +
      "Log as 'checks_failed' instead. The benchmark metric is valid but correctness checks did not pass."
    )
  }

  const previous = await getExperiment($)
  const metricsError = secondaryMetricsError(previous, secondary, params.force === true)
  if (metricsError) return metricsError

  const asi = params.asi && Object.keys(params.asi).length > 0 ? params.asi : undefined
  const added = withResult(previous, {
    run: previous.results.length + 1,
    commit: String(params.commit ?? '').slice(0, 7),
    metric: params.metric,
    metrics: secondary,
    status: params.status,
    description: params.description,
    timestamp: await $.clock.now(),
    segment: previous.currentSegment,
    confidence: null,
    ...(asi ? { asi } : {}),
  })
  let { state, result } = added
  await updateAutoResume($, value => ({ ...value, experimentsThisSession: value.experimentsThisSession + 1 }))

  let text = resultSummary(state, result)

  // Commit only on keep: everything else is reverted anyway.
  if (params.status === 'keep') {
    const message = commitMessage(params.description, params.status, state.metricName, params.metric, secondary)
    const commit = await commitAll($, workDir, message)
    text += `\n${commit.note}`
    if (commit.sha) {
      result = { ...result, commit: commit.sha }
      state = withLastResult(state, result)
    }
  }

  try {
    await appendText($, await sessionFilePath(io, workDir, 'log'), serializeRunEntry(result))
  } catch (error) {
    text += `\n⚠️ Failed to write .auto/log.jsonl: ${error instanceof Error ? error.message : String(error)}`
  }
  await setExperiment($, state)

  if (params.status !== 'keep') text += `\n${await revertChanges($, workDir, params.status)}`

  const runEntry = JSON.parse(serializeRunEntry(result)) as Record<string, unknown>
  const afterSteer = await fireHook($, {
    event: 'after',
    cwd: workDir,
    run_entry: runEntry,
    session: buildSessionSnapshot(state),
  })

  await setRunning($, null)
  await setLastRun($, defaultLastRun())

  let beforeSteer: string | null = null
  if (isIterationLimitReached(state)) {
    text += `\n\n🛑 Maximum experiments reached (${state.maxExperiments}). STOP the experiment loop now.`
    // As upstream: the loop is over, so the mode goes off for this work dir.
    const workDirKey = await canonicalDir($, workDir)
    await updateDecisions($, decisions => ({ ...decisions, [workDirKey]: false }))
    await setEnabled($, false)
  } else if (await getEnabled($)) {
    text += `\n\n${REVISIT_NUDGE}`
    beforeSteer = await fireHook($, {
      event: 'before',
      cwd: workDir,
      next_run: state.results.length + 1,
      last_run: runEntry,
      session: buildSessionSnapshot(state),
    })
  }

  if (afterSteer) text += steerSection('after', afterSteer)
  if (beforeSteer) text += steerSection('before', beforeSteer)
  return text
}
