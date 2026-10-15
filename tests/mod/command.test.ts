import { expect, test } from 'claude-code/testing'

import { getAutoresearchArgumentCompletions } from '../../src/command/subcommands.ts'
import { LOG_WITH_RUN, LoopHost, autoresearch, endTurn, logExperiment, startTurn } from './loop-host.ts'
import { World, startSession } from './world.ts'

test('the command registers as /autoresearch and runs immediately', async ($, on) => {
  const host = new LoopHost(new World('/repo'))
  host.install(on, { enabled: false })
  await startSession($, host.world)
  expect(host.registered).toEqual([{ name: 'autoresearch', immediate: true }])
})

for (const args of ['', 'help', '--help', '-h', '  HELP ']) {
  test(`/autoresearch ${JSON.stringify(args)} shows the help and does not activate`, async ($, on) => {
    const host = new LoopHost(new World('/repo'))
    host.install(on, { enabled: false })
    await startSession($, host.world)

    const text = await autoresearch($, args)
    expect(text).toStartWith('Usage: /autoresearch [off|finalize|clear|export|dashboard|help|<text>]\n\n<text>     Enter autoresearch mode')
    expect(text).toContain('Examples:\n  /autoresearch optimize unit test runtime, monitor correctness')
    expect(host.world.state.enabled ?? false).toBe(false)
    expect(host.submitted).toEqual([])
  })
}

test('/autoresearch <text> with .auto/prompt.md resumes with the text, before.sh steering first', async ($, on) => {
  const world = new World('/repo', { '.auto/prompt.md': '# rules', '.auto/log.jsonl': LOG_WITH_RUN })
  let hookInput: Record<string, unknown> | null = null
  world.script('.auto/hooks/before.sh', input => {
    hookInput = JSON.parse(input ?? 'null')
    return { stdout: 'focus on the parser' }
  })
  const host = new LoopHost(world)
  host.install(on, { enabled: false })
  await startSession($, world)
  // A recorded "off" keeps the logged session from auto-activating.
  await autoresearch($, 'off')

  const text = await autoresearch($, 'go faster')
  expect(text).toBe('Autoresearch mode ON — rules loaded from .auto/prompt.md')
  expect(world.state.enabled).toBe(true)
  expect(world.state.decisions).toEqual({ '/repo': true })
  // The system prompt has not carried the mode's section yet, so the prompt does.
  expect(host.submitted.length).toBe(1)
  expect(host.submitted[0]).toStartWith(
    'focus on the parser\n\nAutoresearch mode active. go faster Be careful not to overfit to the benchmarks and do not cheat on the benchmarks.\n\n## Autoresearch Mode (ACTIVE)',
  )
  expect(hookInput).toMatchObject({ event: 'before', cwd: '/repo', next_run: 2, last_run: { run: 1, description: 'baseline' } })
  expect(hookInput).toMatchObject({ session: { metric_name: 'total_ms', run_count: 1, goal: 'Speed up' } })
})

test('/autoresearch <text> without .auto/prompt.md has the model load the create skill', async ($, on) => {
  const world = new World('/repo')
  world.script('.auto/hooks/before.sh', () => ({ stdout: 'never prepended' }))
  const host = new LoopHost(world)
  host.install(on, { enabled: false })
  await startSession($, world)

  const text = await autoresearch($, 'optimize   test runtime')
  expect(text).toBe('Autoresearch mode ON — no .auto/prompt.md found, loading autoresearch-create skill')
  // Once `prompt.compose` carries the section, the kickoff is the bare skill invocation.
  await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
  host.submitted.length = 0
  await autoresearch($, 'off')
  await autoresearch($, 'optimize   test runtime')
  expect(host.submitted).toEqual([
    'Use the Skill tool to load the `autoresearch:autoresearch-create` skill and follow it.\n' +
      'Arguments: optimize test runtime Be careful not to overfit to the benchmarks and do not cheat on the benchmarks.',
  ])
})

test('/autoresearch <text> while active says so and sends nothing', async ($, on) => {
  const host = new LoopHost(new World('/repo'))
  host.install(on, { enabled: true })
  await startSession($, host.world)
  await autoresearch($, 'first')
  host.submitted.length = 0

  expect(await autoresearch($, 'again')).toBe("Autoresearch already active — use '/autoresearch off' to stop first")
  expect(host.submitted).toEqual([])
})

test('/autoresearch off stops the loop and the turn in flight, and keeps the log', async ($, on) => {
  const world = new World('/repo', { '.auto/prompt.md': '# rules', '.auto/log.jsonl': LOG_WITH_RUN })
  const host = new LoopHost(world)
  host.install(on)
  await startSession($, world)
  expect(world.state.enabled).toBe(true)

  // A turn that logged a run leaves a resume pending; the user's next turn holds it.
  await startTurn($, 'turn-1')
  await logExperiment($)
  await endTurn($, 'turn-1')
  await startTurn($, 'turn-2')
  expect(world.state.autoResume?.pendingResume).not.toBe(null)

  expect(await autoresearch($, 'OFF')).toBe('Autoresearch mode OFF — aborting current run')
  expect(host.aborted).toEqual(['turn-2'])
  expect(world.state.enabled).toBe(false)
  expect(world.state.decisions).toEqual({ '/repo': false })
  expect(world.state.autoResume).toEqual({ turns: 0, experimentsThisSession: 0, pendingResume: null })
  expect(world.file('.auto/log.jsonl')).toStartWith(LOG_WITH_RUN)

  await endTurn($, 'turn-2', 'aborted')
  await world.clock.advance(5_000)
  expect(host.submitted).toEqual([])
  expect(await autoresearch($, 'off')).toBe('Autoresearch mode OFF')
})

test('/autoresearch finalize needs a logged run, then stops the loop and loads the finalize skill', async ($, on) => {
  const world = new World('/repo')
  const host = new LoopHost(world)
  host.install(on, { enabled: true })
  await startSession($, world)

  expect(await autoresearch($, 'finalize')).toBe("No logged experiments to finalize — use '/autoresearch <goal>' to start a session")
  expect(host.submitted).toEqual([])

  world.write('.auto/log.jsonl', LOG_WITH_RUN)
  expect(await autoresearch($, 'finalize')).toBe('Loading autoresearch-finalize skill')
  expect(world.state.enabled).toBe(false)
  expect(host.submitted).toEqual(['Use the Skill tool to load the `autoresearch:autoresearch-finalize` skill and follow it.'])
})

test('/autoresearch finalize mid-turn sends the skill prompt once the aborted turn has ended', async ($, on) => {
  const world = new World('/repo', { '.auto/prompt.md': '# rules', '.auto/log.jsonl': LOG_WITH_RUN })
  const host = new LoopHost(world)
  host.install(on)
  await startSession($, world)
  await startTurn($, 'turn-1')

  expect(await autoresearch($, 'finalize')).toBe('Loading autoresearch-finalize skill')
  expect(host.aborted).toEqual(['turn-1'])
  expect(host.submitted).toEqual([])

  await endTurn($, 'turn-1', 'aborted')
  await world.clock.advance(0)
  expect(host.submitted).toEqual(['Use the Skill tool to load the `autoresearch:autoresearch-finalize` skill and follow it.'])
})

test('/autoresearch clear deletes the log, resets the state and turns the mode off', async ($, on) => {
  const world = new World('/repo', { '.auto/prompt.md': '# rules', '.auto/log.jsonl': LOG_WITH_RUN })
  const host = new LoopHost(world)
  host.install(on)
  await startSession($, world)
  expect(world.state.experiment?.results.length).toBe(1)

  expect(await autoresearch($, 'clear')).toBe('Deleted .auto/log.jsonl and turned autoresearch mode OFF')
  expect(world.file('.auto/log.jsonl')).toBe(undefined)
  expect(world.file('.auto/prompt.md')).toBe('# rules')
  expect(world.state.enabled).toBe(false)
  expect(world.state.decisions).toEqual({ '/repo': false })
  expect(world.state.experiment?.results).toEqual([])
  expect(world.state.paths?.hasPersistedLog).toBe(false)

  expect(await autoresearch($, 'clear')).toBe('No session log found. Autoresearch mode OFF')
})

test('/autoresearch dashboard and export answer what their modules answer, without activating', async ($, on) => {
  const host = new LoopHost(new World('/repo'))
  host.install(on, { enabled: false })
  await startSession($, host.world)

  expect(await autoresearch($, 'dashboard')).toBe('Autoresearch mode is not active.')
  expect(await autoresearch($, 'export')).toContain('export')
  expect(host.world.state.enabled ?? false).toBe(false)
})

test('the first argument completes to the subcommands', () => {
  const names = (prefix: string) => getAutoresearchArgumentCompletions(prefix)?.map(c => c.text) ?? null
  expect(names('o')).toEqual(['off'])
  expect(names('e')).toEqual(['export'])
  expect(names('')).toEqual(['off', 'finalize', 'clear', 'export', 'dashboard', 'help'])
  expect(names('off')).toBe(null)
  expect(names('zz')).toBe(null)
})
