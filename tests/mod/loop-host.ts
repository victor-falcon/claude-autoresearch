// What the command and the loop reach beyond the World's files, git and
// shell: prompts the mod submits, toasts, turn aborts, the command it
// registers, and the engine's own answers to compaction and prompt composing.

import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { World } from './world.ts'

export const LOG_WITH_RUN = [
  '{"type":"config","name":"Speed up","metricName":"total_ms","metricUnit":"ms","bestDirection":"lower"}',
  '{"run":1,"commit":"aaa1111","metric":100,"metrics":{},"status":"keep","description":"baseline","timestamp":1,"segment":0,"confidence":null}',
].join('\n') + '\n'

/** What the engine's compaction leaves: one summary message. */
export const SUMMARY = { role: 'user' as const, text: 'Summary of the conversation so far.', toolUses: [] }

export class LoopHost {
  readonly submitted: string[] = []
  readonly toasts: string[] = []
  readonly aborted: string[] = []
  readonly registered: { name: string; immediate?: true }[] = []
  /** How long the engine's compaction takes, on the mock clock. */
  compactionMs = 0
  /** How many messages the transcript holds (a compaction shrinks it). */
  messageCount = 1

  constructor(readonly world: World) {}

  install(on: On, options: { enabled?: boolean } = {}): void {
    on('prompt.submit', ($, e) => {
      this.submitted.push(e.text)
      return { text: e.text, ...(e.context ? { context: e.context } : {}) }
    })
    on('ui.toast', ($, e) => {
      this.toasts.push(e.text)
      return { value: undefined }
    })
    on('turn.abort', ($, e) => {
      this.aborted.push(e.turnId)
      return { value: undefined }
    })
    on('command.register', ($, e) => {
      this.registered.push({ name: e.name, immediate: e.immediate })
      return { value: { command: e.name } }
    })
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    on('session.compact', async () => {
      if (this.compactionMs > 0) await this.world.clock.sleep(this.compactionMs)
      return { messages: [SUMMARY] }
    })
    on('session.messages', () => ({ value: Array.from({ length: this.messageCount }, () => SUMMARY) }))
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
    this.world.install(on, options)
    settle = () => this.world.clock.advance(0)
  }
}

/** Raise one main-loop turn's start. */
export function startTurn($: Engine, turnId: string): Promise<unknown> {
  return $.turn.start({ text: '', turnId })
}

/** Raise one main-loop turn's end. */
export function endTurn($: Engine, turnId: string, reason: 'answer' | 'aborted' | 'error' = 'answer'): Promise<unknown> {
  return $.turn.complete({ answer: '', durationMs: 1, isAborted: reason === 'aborted', turnId, reason })
}

/** Run `/autoresearch <args>` and answer its text. */
export async function autoresearch($: Engine, args: string): Promise<string> {
  const presentation = { isFullscreen: false, columns: 120 }
  const { text } = await $.command.run({ command: 'autoresearch', args, origin: { kind: 'composer' }, presentation })
  // The prompt a command submits is sent after it returns.
  await settle()
  return text ?? ''
}

let settle: () => Promise<void> = async () => {}

type ToolCall = (input: Record<string, unknown>) => Promise<{ deny?: string; result?: unknown }>

/** Log one experiment through the real tool, as the model does in a turn. */
export async function logExperiment($: Engine, status = 'discard'): Promise<string> {
  const result = await ($.tool.call as unknown as ToolCall)({
    tool: 'mcp__autoresearch__log_experiment', commit: 'abc1234', metric: 120, status, description: 'try it',
  })
  return String(result.deny ?? result.result)
}
