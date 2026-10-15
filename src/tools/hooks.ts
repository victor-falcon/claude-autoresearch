// The user's before/after hook scripts (`.auto/hooks/before.sh|after.sh`),
// ported from pi-autoresearch `hooks.ts`. pi delivers a hook's stdout as a
// steer message; here it rides on the tool result (`steerSection`).

import type { EngineInterface } from 'claude-code'

import { hookLogLineIfConfigured } from '../core/jsonl.ts'
import { hookScriptPath, sessionFilePath, type HookStage } from '../core/paths.ts'
import type { SessionSnapshot } from '../core/state.ts'
import { appendText, fsIo } from '../runtime/fs.ts'
import { cutAtBoundary } from './output.ts'
import { runCommand } from './process.ts'

type Hook$ = Pick<EngineInterface, 'fs' | 'process' | 'clock'>

const TIMEOUT_MS = 30_000
const STDOUT_MAX_BYTES = 8 * 1024
const TRUNCATION_MARKER = '\n…[truncated: hook stdout exceeded 8KB]'

export type { HookStage }

export type BeforeHookPayload = {
  event: 'before'
  cwd: string
  next_run: number
  last_run: Record<string, unknown> | null
  session: SessionSnapshot
}

export type AfterHookPayload = {
  event: 'after'
  cwd: string
  run_entry: Record<string, unknown>
  session: SessionSnapshot
}

export type HookPayload = BeforeHookPayload | AfterHookPayload

export type HookResult = {
  fired: boolean
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
}

const notFired: HookResult = { fired: false, stdout: '', stderr: '', exitCode: null, timedOut: false, durationMs: 0 }

async function isExecutableFile($: Hook$, path: string): Promise<boolean> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat?.kind !== 'file') return false
  const test = await $.process.run(['test', '-x', path]).catch(() => undefined)
  return test?.exitCode === 0
}

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`
}

/**
 * Run the stage's hook script, if it exists and is executable, in `payload.cwd`
 * with the payload as JSON on stdin: 30 s timeout, stdout capped at 8 KB.
 */
export async function runHook($: Hook$, payload: HookPayload): Promise<HookResult> {
  const script = await hookScriptPath(fsIo($), payload.cwd, payload.event)
  if (!(await isExecutableFile($, script))) return notFired

  let stdout = ''
  let stdoutBytes = 0
  let stdoutFull = false
  let stderr = ''
  const encoder = new TextEncoder()
  const outcome = await runCommand($, {
    command: `bash ${shellQuote(script)}`,
    cwd: payload.cwd,
    timeoutMs: TIMEOUT_MS,
    input: JSON.stringify(payload),
    onOutput: (stream, text) => {
      if (stream === 'stderr') {
        stderr += text
        return
      }
      if (stdoutFull) return
      const bytes = encoder.encode(text).length
      const remaining = STDOUT_MAX_BYTES - stdoutBytes
      if (bytes <= remaining) {
        stdout += text
        stdoutBytes += bytes
        return
      }
      stdout += cutAtBoundary(text, remaining) + TRUNCATION_MARKER
      stdoutFull = true
    },
  })
  if (outcome.error) stderr = stderr ? `${stderr}\n${outcome.error}` : outcome.error
  return {
    fired: true,
    stdout,
    stderr,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    durationMs: outcome.durationMs,
  }
}

/** What the agent should read from a hook run, or null for nothing. */
export function steerMessageFor(stage: HookStage, result: HookResult): string | null {
  if (!result.fired) return null
  if (result.timedOut) return `[${stage} hook timed out after ${TIMEOUT_MS / 1000}s]`
  if (result.exitCode !== 0) {
    const parts = [`[${stage} hook exited ${result.exitCode}]`]
    const err = result.stderr.trim()
    const out = result.stdout.trim()
    if (err) parts.push(err)
    if (out) parts.push(out)
    return parts.join('\n')
  }
  return result.stdout.trim() || null
}

/** Append the hook's observability entry, only to a log that has a config header. */
async function appendHookLogEntry($: Hook$, workDir: string, stage: HookStage, result: HookResult): Promise<void> {
  if (!result.fired) return
  try {
    const logPath = await sessionFilePath(fsIo($), workDir, 'log')
    if (!(await $.fs.exists(logPath))) return
    const line = hookLogLineIfConfigured(await $.fs.read(logPath), stage, result)
    if (line) await appendText($, logPath, line)
  } catch {
    // Observability only: never fail the tool over it.
  }
}

/** Run a hook, log it, and answer its steer message (null for none). */
export async function fireHook($: Hook$, payload: HookPayload): Promise<string | null> {
  const result = await runHook($, payload)
  await appendHookLogEntry($, payload.cwd, payload.event, result)
  return steerMessageFor(payload.event, result)
}

/**
 * The hook's message as a clearly delimited section of a tool result: the
 * Claude Code stand-in for pi's `deliverAs: "steer"` user message.
 */
export function steerSection(stage: HookStage, message: string): string {
  return (
    `\n\n━━━ Steer message from .auto/hooks/${stage}.sh ` +
    `(treat it as an instruction from the user) ━━━\n${message}\n━━━ end of ${stage} hook message ━━━`
  )
}
