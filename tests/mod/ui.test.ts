// The widget, status line and dashboard pane, drawn through the test kit's
// surfaces. Only the mod writes its `$.state`, so the state comes from a
// seeded `.auto/log.jsonl` (session start) and from the real tools.

import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { openDashboard } from '../../src/ui/dashboard.ts'
import { World, startSession } from './world.ts'

const PANE = 'autoresearch-dashboard'
const LOG = 'mcp__autoresearch__log_experiment'
const RUN = 'mcp__autoresearch__run_experiment'

const CONFIG = '{"type":"config","name":"Speed up parser","metricName":"total_ms","metricUnit":"ms","bestDirection":"lower"}'
const run = (n: number, metric: number, status: string, description: string, metrics: Record<string, number> = {}) =>
  JSON.stringify({ run: n, commit: status === 'keep' ? `abc${n}def` : '', metric, metrics, status, description, timestamp: n, segment: 0, confidence: null })

const SEEDED = [
  CONFIG,
  run(1, 100, 'keep', 'baseline', { compile_ms: 40 }),
  run(2, 90, 'keep', 'cache tokens', { compile_ms: 35 }),
  run(3, 120, 'discard', 'inline everything', { compile_ms: 50 }),
  run(4, 0, 'crash', 'unsafe rewrite'),
  run(5, 80, 'keep', 'arena allocator', { compile_ms: 30 }),
]

function seeded(lines: string[] = SEEDED): World {
  return new World('/repo', { '.auto/log.jsonl': lines.join('\n') + '\n' })
}

type ToolCall = (input: Record<string, unknown>) => Promise<{ deny?: string; result?: unknown }>
async function call($: { tool: { call: (input: never) => Promise<unknown> } }, tool: string, args: Record<string, unknown>): Promise<string> {
  const result = await ($.tool.call as ToolCall)({ tool, ...args })
  return String(result.deny ?? result.result)
}

/** The engine's ui events beneath the mod, recorded and answered. */
function captureUi(on: On) {
  const seen = { status: [] as (string | undefined)[], opened: [] as string[], closed: [] as string[], scrolls: [] as { offset: number; origin: string }[] }
  on('ui.status', ($, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    seen.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.scroll', ($, e) => {
    seen.scrolls.push({ offset: e.offset, origin: e.origin.kind })
    return {}
  })
  // What the engine draws when the mod passes the band on.
  on('ui.render', () => ({ type: 'Text' as const, children: ['engine band'] }))
  return seen
}

const BAND = { hasSurvey: false, isWorking: true, maxRows: 30, bodyColumns: 120, scroll: { offset: 0, bodyRows: 30 }, view: {} }

async function rows(ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }): Promise<string[]> {
  return (await ui.findAll({ type: 'Text' })).map(t => t.text)
}

test('the widget stays out of the band while the mode is off', async ($, on) => {
  const world = seeded()
  captureUi(on)
  world.install(on, { enabled: false })
  await startSession($, world)
  const ui = await $.ui.mount({ plugin: 'autoresearch', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ text: /autoresearch/ })).toBe(undefined)
  expect(await ui.find({ text: 'engine band' })).not.toBe(undefined)
})

test('the widget draws the results table and redraws as the tools log runs', async ($, on) => {
  const world = seeded()
  captureUi(on)
  world.install(on)
  await startSession($, world)
  const ui = await $.ui.mount({ plugin: 'autoresearch', surface: 'terminal', component: 'AbovePrompt', props: BAND })

  const drawn = await rows(ui)
  expect(drawn.some(row => /^─── 🔬 autoresearch: Speed up parser ─+$/.test(row))).toBe(true)
  expect(drawn.some(row => /Runs: 5 {2}3 kept {2}\(conf: \d+\.\d×\) {2}1 discarded {2}1 crashed$/.test(row))).toBe(true)
  expect(drawn.some(row => row.includes('Progress: ★ total_ms: 80ms #5 (-20.0%)'))).toBe(true)
  expect(drawn.some(row => /^ {2}5 {2}abc5def +80ms +30ms +keep +arena allocator$/.test(row))).toBe(true)
  expect(drawn.some(row => row.endsWith('/autoresearch dashboard'))).toBe(true)
  expect((await ui.find({ type: 'Text', text: /^crash +$/ }))?.props.color).toBe('error')

  const logged = await call($, LOG, { commit: 'x', metric: 120, status: 'discard', description: 'simd scanner', metrics: { compile_ms: 33 } })
  expect(logged).toContain('Logged #6')
  expect((await rows(ui)).some(row => /^ {2}6 +— +120ms +33ms +discard +simd scanner$/.test(row))).toBe(true)
})

test('a running experiment shows a spinner and its elapsed time', async ($, on) => {
  const world = seeded([CONFIG])
  world.scripts.set('sleep 100', () => ({ stdout: 'started\n', hang: true }))
  captureUi(on)
  world.install(on)
  await startSession($, world)
  const ui = await $.ui.mount({ plugin: 'autoresearch', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await rows(ui)).includes('🔬 autoresearch: Speed up parser · no experiments yet')).toBe(true)

  const pending = call($, RUN, { command: 'sleep 100', timeout_seconds: 5 })
  await world.clock.settle()
  expect((await rows(ui)).some(row => /^🔬 . running… 0s │ Speed up parser │ sleep 100 │ waiting for first logged result$/.test(row))).toBe(true)

  // The spinner clock redraws while the run lasts, and stops with it.
  const before = world.invalidated
  await world.clock.advance(3_000)
  expect(world.invalidated - before >= 10).toBe(true)
  await world.clock.advance(2_200)
  await pending
  expect(await ui.find({ text: /running…/ })).toBe(undefined)
  const after = world.invalidated
  await world.clock.advance(3_000)
  expect(world.invalidated).toBe(after)
})

test('the status line follows the mode, the runs and the running experiment', async ($, on) => {
  const world = seeded([CONFIG])
  world.scripts.set('bench', () => ({ stdout: 'METRIC total_ms=100\n' }))
  const seen = captureUi(on)
  world.install(on)
  await startSession($, world)
  expect(seen.status.at(-1)).toBe('🔬 autoresearch · no runs yet')

  await call($, RUN, { command: 'bench' })
  expect(seen.status).toContain('🔬 autoresearch · no runs yet · running…')
  await call($, LOG, { commit: 'x', metric: 100, status: 'keep', description: 'baseline' })
  expect(seen.status.at(-1)).toBe('🔬 autoresearch · 1 run · best total_ms 100ms')
})

test('the status line is cleared while the mode is off', async ($, on) => {
  const world = seeded()
  const seen = captureUi(on)
  world.install(on, { enabled: false })
  await startSession($, world)
  expect(seen.status.at(-1)).toBe(undefined)
})

/** `openDashboard` as T4's command calls it, over a stand-in `$`. */
async function dashboard(values: { enabled: boolean; results: number }): Promise<{ text: string; opened: unknown[] }> {
  const opened: unknown[] = []
  const fake = {
    state: {
      get: async (ref: { key: string }) => ({
        value: ref.key === 'enabled' ? values.enabled : { name: 'Speed up', results: Array.from({ length: values.results }) },
        version: 1,
      }),
    },
    ui: {
      open: async (pane: unknown) => {
        opened.push(pane)
        return { isPlaced: true }
      },
    },
  }
  const text = await openDashboard(fake as unknown as Parameters<typeof openDashboard>[0], '')
  return { text, opened }
}

test('/autoresearch dashboard opens the pane only with the mode on and runs to show', async () => {
  expect(await dashboard({ enabled: false, results: 3 })).toEqual({ text: 'Autoresearch mode is not active.', opened: [] })
  expect(await dashboard({ enabled: true, results: 0 })).toEqual({ text: 'No experiments yet.', opened: [] })
  const shown = await dashboard({ enabled: true, results: 3 })
  expect(shown.text).toContain('Dashboard opened')
  expect(shown.opened).toEqual([{ id: PANE, title: 'autoresearch: Speed up', focus: true, closeOnEscape: true, rows: 19 }])
})

test('the pane lists every run, follows scrolling and closes with q', async ($, on) => {
  const many = [CONFIG, ...Array.from({ length: 40 }, (_, i) => run(i + 1, 100 - i, i % 3 === 1 ? 'discard' : 'keep', `idea ${i + 1}`))]
  const world = seeded(many)
  const seen = captureUi(on)
  world.install(on)
  await startSession($, world)

  const ui = await $.ui.mount({
    plugin: 'autoresearch',
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE,
    props: { title: 'autoresearch', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  const drawn = await rows(ui)
  expect(drawn.some(row => row.includes('idea 1'))).toBe(true)
  expect(drawn.some(row => row.includes('idea 40'))).toBe(true)
  expect(drawn.some(row => row.includes('earlier run'))).toBe(false)
  expect(drawn.some(row => /^1-20\/\d+$/.test(row.trim()))).toBe(true)

  // The person's scroll keys pass through untouched (the engine clamps); the kit cannot resolve a plugin's
  // `$.ui.scroll`, so j/k/d/u/g are exercised by the headless QA instead.
  const person = (offset: number, by: number) =>
    $.ui.scroll({ component: 'Pane', requestId: PANE, offset, by, bodyRows: 20, contentRows: 50, origin: { kind: 'person' } })
  await person(3, 3)
  await person(80, 77)
  expect(seen.scrolls).toEqual([
    { offset: 3, origin: 'person' },
    { offset: 80, origin: 'person' },
  ])
  const keys = (await ui.findAll({ type: 'Button' })).map(b => [b.props.hotkey, b.props.label])
  expect(keys).toEqual([['j', '↓'], ['k', '↑'], ['d', 'page ↓'], ['u', 'page ↑'], ['g', 'top/end'], ['q', 'close']])

  await ui.press({ key: 'key-q' })
  expect(seen.closed).toEqual([PANE])
})
