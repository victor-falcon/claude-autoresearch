import type { On } from 'claude-code'
import { expect, test, type Engine } from 'claude-code/testing'

import { AUTORESUME_TURN_LIMIT, composeResumeMessage } from '../../src/core/autoresume.ts'
import { LOG_WITH_RUN, LoopHost, SUMMARY, autoresearch, endTurn, logExperiment, startTurn } from './loop-host.ts'
import { World, startSession } from './world.ts'

const RESUME = composeResumeMessage()

// Auto-activation at session start

test('a session with a persisted log in the cwd activates the mode', async ($, on) => {
  const host = new LoopHost(new World('/repo', { '.auto/log.jsonl': LOG_WITH_RUN }))
  host.install(on, { enabled: false })
  await startSession($, host.world)
  expect(host.world.state.enabled).toBe(true)
})

test('a session without a log stays off', async ($, on) => {
  const host = new LoopHost(new World('/repo', { '.auto/prompt.md': '# rules' }))
  host.install(on, { enabled: false })
  await startSession($, host.world)
  expect(host.world.state.enabled ?? false).toBe(false)
})

test('a redirected workingDir session stays off until opted in', async ($, on) => {
  const world = new World('/repo', { '.auto/config.json': '{"workingDir":"/repo/pkg"}', 'pkg/.auto/log.jsonl': LOG_WITH_RUN })
  const host = new LoopHost(world)
  host.install(on, { enabled: false })
  await startSession($, world)
  expect(world.state.enabled ?? false).toBe(false)
})

test('an explicit off recorded this session wins over auto-activation', async ($, on) => {
  const host = new LoopHost(new World('/repo', { '.auto/log.jsonl': LOG_WITH_RUN }))
  host.install(on, { enabled: false })
  await startSession($, host.world)
  await autoresearch($, 'off')
  // A reload runs session start again; the decision is the session's.
  await startSession($, host.world)
  expect(host.world.state.enabled ?? false).toBe(false)
})

test('an explicit on recorded this session survives a reload before the log exists', async ($, on) => {
  const host = new LoopHost(new World('/repo'))
  host.install(on, { enabled: false })
  await startSession($, host.world)
  await autoresearch($, 'speed up the parser')
  await startSession($, host.world)
  expect(host.world.state.enabled).toBe(true)
})

// Auto-resume

async function activeSession($: Engine, on: On): Promise<LoopHost> {
  const world = new World('/repo', { '.auto/prompt.md': '# rules', '.auto/log.jsonl': LOG_WITH_RUN })
  const host = new LoopHost(world)
  host.install(on, { enabled: false })
  await startSession($, world)
  expect(world.state.enabled).toBe(true)
  return host
}

test('a turn that logged an experiment is followed by a resume prompt after the settle window', async ($, on) => {
  const host = await activeSession($, on)
  await startTurn($, 't1')
  await logExperiment($)
  await endTurn($, 't1')

  expect(host.world.state.autoResume?.pendingResume).toEqual({ message: RESUME, dueAt: 1_800 })
  await host.world.clock.advance(799)
  expect(host.submitted).toEqual([])
  await host.world.clock.advance(1)
  expect(host.submitted).toEqual([RESUME])
  expect(host.world.state.autoResume?.turns).toBe(1)
  expect(host.world.state.autoResume?.pendingResume).toBe(null)

  // The resumed turn starts a fresh count, logs, and the loop goes on.
  await startTurn($, 't2')
  expect(host.world.state.autoResume?.experimentsThisSession).toBe(0)
  await logExperiment($)
  await endTurn($, 't2')
  await host.world.clock.advance(800)
  expect(host.submitted).toEqual([RESUME, RESUME])
})

test('a chat-only turn never auto-resumes', async ($, on) => {
  const host = await activeSession($, on)
  await startTurn($, 't1')
  await endTurn($, 't1')
  await host.world.clock.advance(5_000)
  expect(host.submitted).toEqual([])
})

test('a turn the user interrupted (Escape) stops the loop from resuming', async ($, on) => {
  const host = await activeSession($, on)
  await startTurn($, 't1')
  await logExperiment($)
  await endTurn($, 't1', 'aborted')
  await host.world.clock.advance(5_000)
  expect(host.submitted).toEqual([])
  expect(host.world.state.autoResume?.pendingResume).toBe(null)
  expect(host.toasts).toEqual(['Autoresearch auto-resume paused — send a message to continue, or /autoresearch off'])
  // The mode stays on: the user's next message picks the loop up again.
  expect(host.world.state.enabled).toBe(true)
})

test('an errored turn does not resume', async ($, on) => {
  const host = await activeSession($, on)
  await startTurn($, 't1')
  await logExperiment($)
  await endTurn($, 't1', 'error')
  await host.world.clock.advance(5_000)
  expect(host.submitted).toEqual([])
})

test('a user turn holds a pending resume back, and its end reschedules it', async ($, on) => {
  const host = await activeSession($, on)
  await startTurn($, 't1')
  await logExperiment($)
  await endTurn($, 't1')
  await host.world.clock.advance(400)
  await startTurn($, 'user')
  await host.world.clock.advance(5_000)
  expect(host.submitted).toEqual([])
  await endTurn($, 'user')
  await host.world.clock.advance(800)
  expect(host.submitted).toEqual([RESUME])
})

test('turning the mode off cancels a pending resume', async ($, on) => {
  const host = await activeSession($, on)
  await startTurn($, 't1')
  await logExperiment($)
  await endTurn($, 't1')
  expect(await autoresearch($, 'off')).toBe('Autoresearch mode OFF')
  await host.world.clock.advance(5_000)
  expect(host.submitted).toEqual([])
})

// Drives 201 full turns: about 1.6 s locally, over the 5 s default on CI runners.
test(`auto-resume stops after ${AUTORESUME_TURN_LIMIT} resume prompts`, { timeoutMs: 30_000 }, async ($, on) => {
  const host = await activeSession($, on)
  for (let i = 0; i <= AUTORESUME_TURN_LIMIT; i++) {
    await startTurn($, `t${i}`)
    await logExperiment($, 'keep')
    await endTurn($, `t${i}`)
    await host.world.clock.advance(800)
  }
  expect(host.submitted.length).toBe(AUTORESUME_TURN_LIMIT)
  expect(host.toasts).toContain(`Autoresearch auto-resume limit reached (${AUTORESUME_TURN_LIMIT} turns)`)
})

test('auto-resume stops after more than 20 consecutive discards or crashes', async ($, on) => {
  const host = await activeSession($, on)
  for (let i = 0; i < 21; i++) await logExperiment($, i % 2 ? 'crash' : 'discard')
  await startTurn($, 't1')
  await logExperiment($)
  await endTurn($, 't1')
  await host.world.clock.advance(5_000)
  expect(host.submitted).toEqual([])
  expect(host.toasts).toEqual(['Autoresearch auto-resume stopped — 22 consecutive discards/crashes'])
})

test('reaching maxIterations turns the mode off, so the loop does not resume', async ($, on) => {
  const world = new World('/repo', { '.auto/prompt.md': '# rules', '.auto/log.jsonl': LOG_WITH_RUN, '.auto/config.json': '{"maxIterations":2}' })
  const host = new LoopHost(world)
  host.install(on, { enabled: false })
  await startSession($, world)
  await startTurn($, 't1')
  expect(await logExperiment($)).toContain('Maximum experiments reached (2)')
  await endTurn($, 't1')
  await world.clock.advance(5_000)
  expect(world.state.enabled ?? false).toBe(false)
  expect(host.submitted).toEqual([])
})

test('subagent turns are ignored', async ($, on) => {
  const host = await activeSession($, on)
  await startTurn($, 't1')
  await logExperiment($)
  await $.turn.start({ text: '', turnId: 'sub', agentId: 'agent-1' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'sub', reason: 'answer', agentId: 'agent-1' })
  await host.world.clock.advance(5_000)
  expect(host.submitted).toEqual([])
  await endTurn($, 't1')
  await host.world.clock.advance(800)
  expect(host.submitted).toEqual([RESUME])
})

// Compaction rehydration

test('after a compaction the model is re-prompted with the persisted state', async ($, on) => {
  const host = await activeSession($, on)
  host.world.write('.auto/ideas.md', '- try SIMD')
  host.world.write('src/app.js', 'faster')
  await logExperiment($, 'keep')

  await $.session.compact({ trigger: 'auto', messages: [SUMMARY] })
  await host.world.clock.advance(800)

  expect(host.submitted.length).toBe(1)
  const message = host.submitted[0]!
  expect(message).toStartWith('# Autoresearch Compaction Summary')
  expect(message).toContain('## Experiment Rules (.auto/prompt.md)\n\n# rules')
  expect(message).toContain('## Ideas Backlog (.auto/ideas.md)\n\n- try SIMD')
  expect(message).toContain('#1 keep          100 | desc: baseline')
  expect(message).toContain('## Recent Commits (git log --oneline -n 10)\n\nc0ffee0 try it')
  expect(message).toContain('Run the next iteration now. Pick the most promising hypothesis')
  expect(message).toContain('## Autoresearch Mode (ACTIVE)')
})

test('a resume due during a compaction waits for it, and the rehydration prompt replaces it', async ($, on) => {
  const host = await activeSession($, on)
  await startTurn($, 't1')
  await logExperiment($)
  await endTurn($, 't1')
  host.compactionMs = 5_000

  const compaction = $.session.compact({ trigger: 'manual', messages: [SUMMARY] })
  await host.world.clock.advance(2_000)
  expect(host.submitted).toEqual([])
  await host.world.clock.advance(3_000)
  await compaction
  await host.world.clock.advance(800)

  expect(host.submitted.length).toBe(1)
  expect(host.submitted[0]).toStartWith('# Autoresearch Compaction Summary')
})

test('/autoresearch off queued behind a compaction drops the resume that was due', async ($, on) => {
  const host = await activeSession($, on)
  await startTurn($, 't1')
  await logExperiment($)
  await endTurn($, 't1')
  host.compactionMs = 5_000

  const compaction = $.session.compact({ trigger: 'manual', messages: [SUMMARY] })
  await host.world.clock.advance(5_000)
  await compaction
  expect(await autoresearch($, 'off')).toBe('Autoresearch mode OFF')
  await host.world.clock.advance(5_000)
  expect(host.submitted).toEqual([])
})

test('no re-prompt after a compaction while the mode is off, or a skipped one', async ($, on) => {
  const host = new LoopHost(new World('/repo', { '.auto/prompt.md': '# rules' }))
  host.install(on, { enabled: false })
  await startSession($, host.world)
  await $.session.compact({ trigger: 'manual', messages: [SUMMARY] })
  await host.world.clock.advance(5_000)
  expect(host.submitted).toEqual([])
})

test('where session.compact is bypassed, /compact still re-prompts with the persisted state', async ($, on) => {
  let compacted = 0
  on('command.run', { command: 'compact' }, () => {
    compacted++
    return { text: 'Compacted' }
  })
  const host = await activeSession($, on)
  await $.command.run({ command: 'compact', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  await host.world.clock.advance(800)
  expect(compacted).toBe(1)
  expect(host.submitted.length).toBe(1)
  expect(host.submitted[0]).toStartWith('# Autoresearch Compaction Summary')
})

test('where session.compact is bypassed, a transcript that shrank during a turn means it compacted', async ($, on) => {
  const host = await activeSession($, on)
  host.messageCount = 40
  await startTurn($, 't1')
  await endTurn($, 't1')
  await startTurn($, 't2')
  await logExperiment($)
  host.messageCount = 3
  await endTurn($, 't2')
  await host.world.clock.advance(800)
  expect(host.submitted.length).toBe(1)
  expect(host.submitted[0]).toStartWith('# Autoresearch Compaction Summary')
})

// System prompt

test('where prompt.compose is bypassed, the user\'s prompts carry the section as context', async ($, on) => {
  const host = await activeSession($, on)
  const submit = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

  const { context } = await submit('keep going')
  expect(context?.length).toBe(1)
  expect(context?.[0]).toStartWith('## Autoresearch Mode (ACTIVE)')

  await autoresearch($, 'off')
  expect((await submit('thanks')).context).toBe(undefined)
  expect(host.submitted).toEqual(['keep going', 'thanks'])
})


test('the system prompt carries the autoresearch section while the mode is on', async ($, on) => {
  const host = await activeSession($, on)
  host.world.write('.auto/checks.sh', '#!/bin/bash')
  const compose = () => $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })

  const { sections } = await compose()
  expect(sections.map(s => s.id)).toEqual(['intro', 'autoresearch:mode'])
  const text = sections[1]!.text
  expect(sections[1]!.scope).toBe('session')
  expect(text).toStartWith('## Autoresearch Mode (ACTIVE)')
  expect(text).toContain('Experiment rules: /repo/.auto/prompt.md — read this file')
  expect(text).toContain('## Backpressure Checks (ACTIVE)\n/repo/.auto/checks.sh exists')
  expect(text).not.toContain('Ideas backlog')

  await autoresearch($, 'off')
  expect((await compose()).sections.map(s => s.id)).toEqual(['intro'])
})
