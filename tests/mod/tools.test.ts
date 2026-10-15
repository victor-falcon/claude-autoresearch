import { expect, test } from 'claude-code/testing'

import { World, startSession } from './world.ts'

const INIT = 'mcp__autoresearch__init_experiment'
const RUN = 'mcp__autoresearch__run_experiment'
const LOG = 'mcp__autoresearch__log_experiment'

type ToolCall = (input: Record<string, unknown>) => Promise<{ deny?: string; result?: unknown }>
type Tool$ = { tool: { call: (input: never) => Promise<unknown> } }

/** Call a tool and answer the text the model reads. */
async function call($: Tool$, tool: string, args: Record<string, unknown>): Promise<string> {
  // The mod's tools are not in the engine's typed tool table.
  const result = await ($.tool.call as ToolCall)({ tool, ...args })
  return String(result.deny ?? result.result)
}

function measure(world: World, metric: () => number, extra = ''): void {
  world.script('.auto/measure.sh', () => ({ stdout: `building...\nMETRIC total_ms=${metric()}\n${extra}` }))
  const handler = world.scripts.get(`bash '${world.cwd}/.auto/measure.sh'`)!
  world.scripts.set('bash .auto/measure.sh', handler)
  world.scripts.set('./.auto/measure.sh', handler)
}

async function init($: Tool$, extra: Record<string, unknown> = {}): Promise<string> {
  return call($, INIT, { name: 'Speed up', metric_name: 'total_ms', metric_unit: 'ms', ...extra })
}

test('the tools refuse to run while autoresearch mode is off', async ($, on) => {
  const world = new World('/repo')
  world.install(on, { enabled: false })
  await startSession($, world)

  const text = await init($)
  expect(text).toContain('Autoresearch mode is off')
  expect(world.file('.auto/log.jsonl')).toBe(undefined)
})

test('init → run → keep → run → discard: commits, reverts and logs like upstream', async ($, on) => {
  const world = new World('/repo', { 'src/app.js': 'v1' })
  let ms = 100
  measure(world, () => ms)
  world.install(on)
  await startSession($, world)

  expect(await init($)).toBe(
    '✅ Experiment initialized: "Speed up"\nMetric: total_ms (ms, lower is better)\nConfig written to .auto/log.jsonl. Now run the baseline with run_experiment.',
  )

  // Only the benchmark script may run once it exists.
  const refused = await call($, RUN, { command: 'node bench.js' })
  expect(refused).toContain('❌ .auto/measure.sh exists — you must run it instead of a custom command.')

  const baseline = await call($, RUN, { command: 'bash .auto/measure.sh' })
  expect(baseline).toContain('✅ PASSED in ')
  expect(baseline).toContain('📐 Parsed metrics: ★ total_ms=100ms')
  expect(baseline).toContain('Use these values directly in log_experiment (metric: 100, metrics: {})')
  expect(world.state.running).toBe(null)
  expect(world.state.lastRun?.checks).toBe(null)

  world.write('src/app.js', 'v2')
  const kept = await call($, LOG, {
    commit: 'abcdef123', metric: 100, status: 'keep', description: 'baseline', asi: { hypothesis: 'baseline' },
  })
  expect(kept).toContain('Logged #1: keep — baseline\nBaseline total_ms: 100ms')
  expect(kept).toContain('📋 ASI: hypothesis: baseline')
  expect(kept).toContain('(1 experiments)')
  expect(kept).toContain('📝 Git: committed — [main c0ffee0] baseline')
  expect(world.commits[0]?.message).toBe('baseline\n\nResult: {"status":"keep","total_ms":100}')

  ms = 120
  world.write('src/app.js', 'v3')
  world.write('src/new.js', 'untracked')
  world.write('.auto/ideas.md', '- try caching')
  await call($, RUN, { command: './.auto/measure.sh' })
  const discarded = await call($, LOG, {
    commit: 'c0ffee0', metric: 120, status: 'discard', description: 'slower loop',
    asi: { hypothesis: 'unroll', rollback_reason: 'slower' },
  })
  expect(discarded).toContain('Logged #2: discard — slower loop')
  expect(discarded).toContain('📝 Git: reverted changes (discard) — autoresearch files preserved')

  // Code is back to the kept commit; session files survive the revert.
  expect(world.file('src/app.js')).toBe('v2')
  expect(world.file('src/new.js')).toBe(undefined)
  expect(world.file('.auto/ideas.md')).toBe('- try caching')
  expect(world.commits.length).toBe(1)

  const lines = world.logLines()
  expect(lines.length).toBe(3)
  expect(lines[1]).toEqual({
    run: 1, commit: 'c0ffee0', metric: 100, metrics: {}, status: 'keep', description: 'baseline',
    timestamp: lines[1]!.timestamp, segment: 0, confidence: null, asi: { hypothesis: 'baseline' },
  })
  expect(Object.keys(lines[2]!)).toEqual(['run', 'commit', 'metric', 'metrics', 'status', 'description', 'timestamp', 'segment', 'confidence', 'asi'])
  expect(lines[2]!.status).toBe('discard')
  expect(world.state.experiment?.results.length).toBe(2)
  expect(world.state.experiment?.baselineMetric).toBe(100)
  expect(world.state.experiment?.bestKeptMetric).toBe(100)
  expect(world.state.autoResume?.experimentsThisSession).toBe(2)
})

test('a failed checks.sh blocks keep and is logged as checks_failed', async ($, on) => {
  const world = new World('/repo', { 'src/app.js': 'v1' })
  measure(world, () => 90)
  world.script('.auto/checks.sh', () => ({ stdout: 'running tests\n', stderr: '1 test failed\n', code: 1 }))
  world.install(on)
  await startSession($, world)
  await init($)

  const ran = await call($, RUN, { command: 'bash .auto/measure.sh' })
  expect(ran).toContain('✅ Benchmark PASSED in ')
  expect(ran).toContain('💥 CHECKS FAILED (.auto/checks.sh) in ')
  expect(ran).toContain("Log this as 'checks_failed'")
  expect(ran).toContain('── Checks output (last 80 lines) ──\nrunning tests\n\n1 test failed')
  expect(world.state.lastRun?.checks?.pass).toBe(false)

  world.write('src/app.js', 'broken')
  const refused = await call($, LOG, { commit: 'x', metric: 90, status: 'keep', description: 'fast but wrong' })
  expect(refused).toContain('❌ Cannot keep — .auto/checks.sh failed.')
  expect(world.logLines().length).toBe(1)

  const logged = await call($, LOG, { commit: 'x', metric: 90, status: 'checks_failed', description: 'fast but wrong' })
  expect(logged).toContain('Logged #1: checks_failed — fast but wrong')
  expect(logged).toContain('📝 Git: reverted changes (checks_failed)')
  expect(world.file('src/app.js')).toBe('v1')
  expect(world.state.lastRun).toEqual({ checks: null, durationSeconds: null })
})

test('checks.sh is skipped when the benchmark fails', async ($, on) => {
  const world = new World('/repo')
  world.script('.auto/measure.sh', () => ({ stdout: 'boom\n', code: 2 }))
  world.scripts.set('bash .auto/measure.sh', world.scripts.get("bash '/repo/.auto/measure.sh'")!)
  world.script('.auto/checks.sh', () => ({ code: 0 }))
  world.install(on)
  await startSession($, world)
  await init($)

  const ran = await call($, RUN, { command: 'bash .auto/measure.sh' })
  expect(ran).toContain('💥 FAILED (exit code 2) in ')
  expect(world.spawned).toEqual(['bash .auto/measure.sh'])
})

test('secondary metrics must stay consistent unless forced', async ($, on) => {
  const world = new World('/repo')
  world.install(on)
  await startSession($, world)
  await init($)

  await call($, LOG, { commit: 'a', metric: 100, status: 'keep', description: 'base', metrics: { compile_ms: 40 } })
  const missing = await call($, LOG, { commit: 'b', metric: 90, status: 'keep', description: 'next' })
  expect(missing).toContain('❌ Missing secondary metrics: compile_ms')

  const added = await call($, LOG, { commit: 'b', metric: 90, status: 'discard', description: 'next', metrics: { compile_ms: 30, heap_mb: 5 } })
  expect(added).toContain('❌ New secondary metric not previously tracked: heap_mb')

  const forced = await call($, LOG, {
    commit: 'b', metric: 90, status: 'discard', description: 'next', metrics: { compile_ms: 30, heap_mb: 5 }, force: true,
  })
  expect(forced).toContain('Secondary: compile_ms: 30ms (-25.0%)  heap_mb: 5mb')
  expect(world.state.experiment?.secondaryMetrics).toEqual([
    { name: 'compile_ms', unit: 'ms' },
    { name: 'heap_mb', unit: 'mb' },
  ])
})

test('confidence is reported once the segment has enough runs', async ($, on) => {
  const world = new World('/repo')
  world.install(on)
  await startSession($, world)
  await init($)

  await call($, LOG, { commit: 'a', metric: 100, status: 'keep', description: 'base' })
  await call($, LOG, { commit: 'b', metric: 98, status: 'discard', description: 'noise' })
  const third = await call($, LOG, { commit: 'c', metric: 80, status: 'keep', description: 'cache' })
  expect(third).toContain('Baseline total_ms: 100ms | this: 80ms (-20.0%)')
  expect(third).toContain('📊 Confidence: 10.0× noise floor — improvement is likely real')
  expect(world.logLines().at(-1)?.confidence).toBe(10)
})

test('maxIterations stops the loop and turns the mode off', async ($, on) => {
  const world = new World('/repo', { '.auto/config.json': '{"maxIterations":2}' })
  measure(world, () => 50)
  world.install(on)
  await startSession($, world)
  expect(await init($)).toContain('Max iterations: 2 (from .auto/config.json)')

  await call($, LOG, { commit: 'a', metric: 50, status: 'keep', description: 'one' })
  const last = await call($, LOG, { commit: 'b', metric: 55, status: 'discard', description: 'two' })
  expect(last).toContain('(2 experiments / 2 max)')
  expect(last).toContain('🛑 Maximum experiments reached (2). STOP the experiment loop now.')
  expect(world.state.enabled).toBe(false)
  expect(world.state.decisions).toEqual({ '/repo': false })
  expect(world.invalidated > 0).toBe(true)

  // With the mode off the tools refuse, as they would after re-enabling until a new segment.
  expect(await call($, RUN, { command: 'bash .auto/measure.sh' })).toContain('Autoresearch mode is off')
})

test('run_experiment refuses once maxIterations is reached in the segment', async ($, on) => {
  const world = new World('/repo', {
    '.auto/config.json': '{"maxIterations":1}',
    '.auto/log.jsonl':
      '{"type":"config","name":"x","metricName":"total_ms","metricUnit":"ms","bestDirection":"lower"}\n' +
      '{"run":1,"commit":"a","metric":1,"metrics":{},"status":"keep","description":"d","timestamp":1,"segment":0,"confidence":null}\n',
  })
  world.install(on)
  await startSession($, world)

  expect(await call($, RUN, { command: 'true' })).toBe(
    '🛑 Maximum experiments reached (1). The experiment loop is done. To continue, call init_experiment to start a new segment.',
  )
  // A new segment resets the count.
  expect(await init($)).toContain('(re-initialized — previous results archived, new baseline needed)')
  expect(world.state.experiment?.currentSegment).toBe(1)
})

test('after and before hooks get upstream stdin, log entries, and steer the agent', async ($, on) => {
  const world = new World('/repo')
  const stdin: Record<string, unknown>[] = []
  world.script('.auto/hooks/after.sh', input => {
    stdin.push(JSON.parse(input!))
    return { stdout: 'learned: caching helps\n' }
  })
  world.script('.auto/hooks/before.sh', input => {
    stdin.push(JSON.parse(input!))
    return { stdout: 'x'.repeat(9000), code: 3, stderr: 'oops\n' }
  })
  world.install(on)
  await startSession($, world)
  await init($)

  const text = await call($, LOG, { commit: 'a', metric: 100, status: 'keep', description: 'base' })

  expect(stdin[0]).toEqual({
    event: 'after',
    cwd: '/repo',
    run_entry: world.logLines()[1],
    session: { metric_name: 'total_ms', metric_unit: 'ms', direction: 'lower', baseline_metric: 100, best_metric: 100, run_count: 1, goal: 'Speed up' },
  })
  expect(stdin[1]).toEqual({
    event: 'before',
    cwd: '/repo',
    next_run: 2,
    last_run: world.logLines()[1],
    session: { metric_name: 'total_ms', metric_unit: 'ms', direction: 'lower', baseline_metric: 100, best_metric: 100, run_count: 1, goal: 'Speed up' },
  })

  expect(text).toContain("Before choosing the next experiment, consider whether this result or discovery invalidates a previous discard's rollback reason.")
  expect(text).toContain('━━━ Steer message from .auto/hooks/after.sh (treat it as an instruction from the user) ━━━\nlearned: caching helps\n━━━ end of after hook message ━━━')
  expect(text).toContain('━━━ Steer message from .auto/hooks/before.sh (treat it as an instruction from the user) ━━━\n[before hook exited 3]\noops\n')
  expect(text).toContain('…[truncated: hook stdout exceeded 8KB]')

  const hooks = world.logLines().filter(line => line.type === 'hook')
  expect(hooks.map(line => [line.stage, line.exit_code, line.timed_out])).toEqual([['after', 0, false], ['before', 3, false]])
  expect(hooks[1]!.stdout_bytes).toBe(8192 + new TextEncoder().encode('\n…[truncated: hook stdout exceeded 8KB]').length)
})

test('hooks that are not executable never fire', async ($, on) => {
  const world = new World('/repo')
  world.script('.auto/hooks/after.sh', () => ({ stdout: 'should not run' }), false)
  world.install(on)
  await startSession($, world)
  await init($)

  const text = await call($, LOG, { commit: 'a', metric: 1, status: 'keep', description: 'base' })
  expect(text.includes('Steer message')).toBe(false)
  expect(world.spawned).toEqual([])
  expect(world.logLines().some(line => line.type === 'hook')).toBe(false)
})

test('a benchmark over its timeout is killed and reported', async ($, on) => {
  const world = new World('/repo')
  world.scripts.set('sleep 100', () => ({ stdout: 'started\n', hang: true }))
  world.install(on)
  await startSession($, world)
  await init($)
  const { clock } = world

  const pending = call($, RUN, { command: 'sleep 100', timeout_seconds: 5 })
  await clock.settle()
  expect(world.state.running).toEqual({ startedAt: 1_000, command: 'sleep 100' })
  await clock.advance(5_000)
  await clock.advance(200)
  const text = await pending
  expect(text).toContain('⏰ TIMEOUT after 5.')
  expect(text).toContain('started')
  expect(world.state.running).toBe(null)
})
