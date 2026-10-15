// Running shell commands for the tools through `$.process.spawn`: no 30 s cap,
// a timeout of our own, the whole process tree killed on timeout or abort.

import type { EngineInterface } from 'claude-code'

type Process$ = Pick<EngineInterface, 'process' | 'clock'>

/**
 * Runs `$1` in its own process group (`set -m` puts the background job in a
 * group of its own) and forwards a TERM/INT/HUP to that whole group, so
 * killing this wrapper kills every process the command started, as
 * upstream's `detached` spawn + `kill(-pid)` does. Exits with the command's
 * status.
 */
const GROUP_WRAPPER =
  'set -m; bash -c "$1" & pid=$!; ' +
  "trap 'kill -TERM -- -$pid 2>/dev/null; exit 143' TERM INT HUP; " +
  'wait $pid'

export type CommandRequest = {
  /** A bash command line. */
  command: string
  cwd: string
  /** 0 or less: no timeout. */
  timeoutMs: number
  /** Written to stdin, then closed. */
  input?: string
  /** Aborts the run (the tree is killed); also `abortRunningExperiment`. */
  signal?: AbortSignal
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void
}

export type CommandOutcome = {
  /** null when the process was killed or could not start. */
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  /** Why it could not start; null when it ran. */
  error: string | null
  durationMs: number
}

/** Run a bash command line to completion, streaming its output to `onOutput`. */
export async function runCommand($: Process$, request: CommandRequest): Promise<CommandOutcome> {
  const startedAt = await $.clock.now()
  const stream = $.process.spawn({
    argv: ['bash', '-c', GROUP_WRAPPER, 'autoresearch', request.command],
    cwd: request.cwd,
    ...(request.input !== undefined ? { input: request.input } : {}),
  })

  let timedOut = false
  let aborted = false
  // Ending the stream kills the wrapper, whose trap kills the group.
  const stop = () => void stream.return(undefined as never).catch(() => undefined)
  const timer = request.timeoutMs > 0
    ? $.clock.after(request.timeoutMs, () => {
        timedOut = true
        stop()
      })
    : null
  const onAbort = () => {
    aborted = true
    stop()
  }
  if (request.signal?.aborted) onAbort()
  else request.signal?.addEventListener('abort', onAbort, { once: true })

  let exitCode: number | null = null
  let error: string | null = null
  try {
    for (;;) {
      const step = await stream.next()
      if (step.done) {
        // undefined when we ended the stream ourselves.
        exitCode = step.value?.code ?? null
        break
      }
      request.onOutput?.(step.value.stream, step.value.text)
    }
  } catch (cause) {
    if (!timedOut && !aborted) error = cause instanceof Error ? cause.message : String(cause)
  } finally {
    timer?.cancel()
    request.signal?.removeEventListener('abort', onAbort)
  }
  if (timedOut || aborted) exitCode = null
  return { exitCode, timedOut, aborted, error, durationMs: (await $.clock.now()) - startedAt }
}

// The experiment run in flight, so `/autoresearch off|finalize` (T4) can stop it.
let runningAbort: AbortController | null = null

/**
 * A signal for the experiment about to run, aborted by `abortRunningExperiment`
 * or by `linked` (the tool call's own signal); it replaces any earlier one.
 */
export function beginExperimentRun(linked?: AbortSignal): AbortSignal {
  const controller = new AbortController()
  if (linked?.aborted) controller.abort()
  else linked?.addEventListener('abort', () => controller.abort(), { once: true })
  runningAbort = controller
  return controller.signal
}

export function endExperimentRun(signal: AbortSignal): void {
  if (runningAbort?.signal === signal) runningAbort = null
}

/**
 * Abort the `run_experiment` (benchmark or checks) in progress, killing its
 * process tree. Resolves whether one was running. Used by T4's
 * `/autoresearch off` and `/autoresearch finalize`.
 */
export function abortRunningExperiment(): boolean {
  if (!runningAbort) return false
  runningAbort.abort()
  runningAbort = null
  return true
}
