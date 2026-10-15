// run_experiment: run the benchmark, then .auto/checks.sh, and report to the
// model like upstream (index.ts, `run_experiment`).

import type { EngineInterface } from 'claude-code'

import type { LastRunChecks } from '../../types/index.d.ts'
import { resolveWorkDir, validateWorkDir } from '../core/config.ts'
import { formatNum, isAutoresearchShCommand, parseMetricLines } from '../core/metrics.ts'
import { sessionFilePath } from '../core/paths.ts'
import { relative } from '../core/pathutil.ts'
import { isIterationLimitReached } from '../core/state.ts'
import { fsIo } from '../runtime/fs.ts'
import { getExperiment, setLastRun, setRunning } from '../runtime/state.ts'
import {
  DEFAULT_MAX_BYTES,
  EXPERIMENT_MAX_BYTES,
  EXPERIMENT_MAX_LINES,
  RollingTail,
  formatSize,
  truncateTail,
} from './output.ts'
import { beginExperimentRun, endExperimentRun, runCommand } from './process.ts'

type Run$ = Pick<EngineInterface, 'fs' | 'session' | 'state' | 'process' | 'clock' | 'env'>

export type RunParams = {
  command: string
  timeout_seconds?: number
  checks_timeout_seconds?: number
}

/** The most of a run's output kept for the full-output file: ≤ 4 MiB, $.fs's write limit, at 4 bytes a character. */
const FULL_OUTPUT_MAX_CHARS = 1_000_000
const CHECKS_OUTPUT_MAX_BYTES = 1024 * 1024

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`
}

function randomId(): string {
  let id = ''
  for (let i = 0; i < 16; i++) id += Math.floor(Math.random() * 16).toString(16)
  return id
}

/** Where a truncated run's full output goes (upstream: the OS temp dir). */
async function writeFullOutput($: Run$, text: string): Promise<string | undefined> {
  try {
    const tmp = ((await $.env.get('TMPDIR')) || '/tmp').replace(/\/+$/, '')
    const path = `${tmp}/autoresearch-experiment-${randomId()}.log`
    await $.fs.write(path, text)
    return path
  } catch {
    return undefined
  }
}

type ChecksOutcome = LastRunChecks & { timedOut: boolean }

async function runChecks($: Run$, checksPath: string, workDir: string, timeoutMs: number, signal: AbortSignal): Promise<ChecksOutcome> {
  const stdout = new RollingTail(CHECKS_OUTPUT_MAX_BYTES)
  const stderr = new RollingTail(CHECKS_OUTPUT_MAX_BYTES)
  const outcome = await runCommand($, {
    command: `bash ${shellQuote(checksPath)}`,
    cwd: workDir,
    timeoutMs,
    signal,
    onOutput: (stream, text) => (stream === 'stdout' ? stdout : stderr).push(text),
  })
  const duration = outcome.durationMs / 1000
  if (outcome.error) return { pass: false, output: outcome.error, duration, timedOut: false }
  return {
    pass: outcome.exitCode === 0 && !outcome.timedOut && !outcome.aborted,
    output: (stdout.toString() + '\n' + stderr.toString()).trim(),
    duration,
    timedOut: outcome.timedOut,
  }
}

export async function runExperiment($: Run$, params: RunParams, toolSignal?: AbortSignal): Promise<string> {
  const io = fsIo($)
  const cwd = await $.session.cwd()
  const workDirError = await validateWorkDir(io, cwd)
  if (workDirError) return `❌ ${workDirError}`
  const workDir = await resolveWorkDir(io, cwd)

  const state = await getExperiment($)
  if (isIterationLimitReached(state)) {
    return `🛑 Maximum experiments reached (${state.maxExperiments}). The experiment loop is done. To continue, call init_experiment to start a new segment.`
  }

  // If the benchmark script exists, only it may run.
  const measurePath = await sessionFilePath(io, workDir, 'measure')
  const measureRel = relative(workDir, measurePath)
  if ((await io.exists(measurePath)) && !isAutoresearchShCommand(params.command)) {
    return (
      `❌ ${measureRel} exists — you must run it instead of a custom command.\n\n` +
      `Found: ${measurePath}\nYour command: ${params.command}\n\n` +
      `Use: run_experiment({ command: "bash ${measureRel}" }) or run_experiment({ command: "./${measureRel}" })`
    )
  }

  const signal = beginExperimentRun(toolSignal)

  const startedAt = await $.clock.now()
  await setRunning($, { startedAt, command: params.command })
  try {
    const tail = new RollingTail(DEFAULT_MAX_BYTES * 2)
    let full = ''
    let fullDropped = false
    const outcome = await runCommand($, {
      command: params.command,
      cwd: workDir,
      timeoutMs: (params.timeout_seconds ?? 600) * 1000,
      signal,
      onOutput: (_stream, text) => {
        tail.push(text)
        full += text
        if (full.length > FULL_OUTPUT_MAX_CHARS) {
          full = full.slice(full.length - FULL_OUTPUT_MAX_CHARS / 2)
          fullDropped = true
        }
      },
    })
    if (outcome.error) throw new Error(outcome.error)
    if (outcome.aborted) {
      return `🛑 Experiment aborted after ${(outcome.durationMs / 1000).toFixed(1)}s. Nothing was measured; do not log this run.`
    }

    const durationSeconds = outcome.durationMs / 1000
    const benchmarkPassed = outcome.exitCode === 0 && !outcome.timedOut

    // Backpressure checks, only once the benchmark passed.
    let checks: ChecksOutcome | null = null
    const checksPath = await sessionFilePath(io, workDir, 'checks')
    if (benchmarkPassed && (await io.exists(checksPath))) {
      checks = await runChecks($, checksPath, workDir, (params.checks_timeout_seconds ?? 300) * 1000, signal)
      if (signal.aborted) {
        return `🛑 Experiment aborted while running .auto/checks.sh. Nothing was measured; do not log this run.`
      }
    }
    await setLastRun($, {
      checks: checks ? { pass: checks.pass, output: checks.output, duration: checks.duration } : null,
      durationSeconds,
    })

    const output = tail.toString()
    const llm = truncateTail(output, EXPERIMENT_MAX_LINES, EXPERIMENT_MAX_BYTES)
    let fullOutputPath: string | undefined
    if (tail.totalBytes > EXPERIMENT_MAX_BYTES || output.split('\n').length > EXPERIMENT_MAX_LINES) {
      fullOutputPath = await writeFullOutput($, (fullDropped ? '[…earlier output dropped]\n' : '') + full)
    }

    const metrics = parseMetricLines(output)
    const parsedPrimary = metrics.get(state.metricName) ?? null
    const checksOutput = checks ? checks.output.split('\n').slice(-80).join('\n') : ''

    let text = ''
    if (outcome.timedOut) {
      text += `⏰ TIMEOUT after ${durationSeconds.toFixed(1)}s\n`
    } else if (!benchmarkPassed) {
      text += `💥 FAILED (exit code ${outcome.exitCode}) in ${durationSeconds.toFixed(1)}s\n`
    } else if (checks?.timedOut) {
      text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`
      text += `⏰ CHECKS TIMEOUT (.auto/checks.sh) after ${checks.duration.toFixed(1)}s\n`
      text += `Log this as 'checks_failed' — the benchmark metric is valid but checks timed out.\n`
    } else if (checks && !checks.pass) {
      text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`
      text += `💥 CHECKS FAILED (.auto/checks.sh) in ${checks.duration.toFixed(1)}s\n`
      text += `Log this as 'checks_failed' — the benchmark metric is valid but correctness checks did not pass.\n`
    } else {
      text += `✅ PASSED in ${durationSeconds.toFixed(1)}s\n`
      if (checks?.pass) text += `✅ Checks passed in ${checks.duration.toFixed(1)}s\n`
    }

    const best = state.bestKeptMetric ?? state.baselineMetric
    if (best !== null) {
      text += `📊 Current best ${state.metricName}: ${formatNum(best, state.metricUnit)}\n`
    }

    if (metrics.size > 0) {
      const secondary = [...metrics].filter(([name]) => name !== state.metricName)
      text += `\n📐 Parsed metrics:`
      if (parsedPrimary !== null) text += ` ★ ${state.metricName}=${formatNum(parsedPrimary, state.metricUnit)}`
      for (const [name, value] of secondary) {
        const unit = state.secondaryMetrics.find(metric => metric.name === name)?.unit ?? ''
        text += ` ${name}=${formatNum(value, unit)}`
      }
      text += `\nUse these values directly in log_experiment (metric: ${parsedPrimary ?? '?'}, metrics: {${secondary.map(([name, value]) => `"${name}": ${value}`).join(', ')}})\n`
    }

    text += `\n${llm.content}`
    if (llm.truncated) {
      text += llm.truncatedBy === 'lines'
        ? `\n\n[Showing last ${llm.outputLines} of ${llm.totalLines} lines.`
        : `\n\n[Showing last ${llm.outputLines} lines (${formatSize(EXPERIMENT_MAX_BYTES)} limit).`
      if (fullOutputPath) text += ` Full output: ${fullOutputPath}`
      text += `]`
    }

    if (checks && !checks.pass) text += `\n\n── Checks output (last 80 lines) ──\n${checksOutput}`
    return text
  } finally {
    endExperimentRun(signal)
    await setRunning($, null)
  }
}
