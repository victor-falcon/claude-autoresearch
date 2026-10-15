import assert from 'node:assert/strict'
import test from 'node:test'

import type { ExperimentResult, ExperimentState, ExperimentStatus } from '../../types/index.d.ts'
import { createExperimentState, withDerivedMetrics } from '../../src/core/state.ts'
import {
  cellWidth,
  confidenceTone,
  dashboardLines,
  lineWidth,
  paneLines,
  spinnerFrame,
  statusText,
  truncateLine,
  truncateText,
  widgetLines,
  withRightHint,
  type Line,
} from '../../src/ui/format.ts'

const text = (line: Line) => line.map(part => part.text).join('')

function result(run: number, metric: number, status: ExperimentStatus, description: string, metrics: Record<string, number> = {}, segment = 0): ExperimentResult {
  return { run, commit: status === 'keep' ? `c0ffee${run}` : '', metric, metrics, status, description, timestamp: run, segment, confidence: null }
}

function session(results: ExperimentResult[], extra: Partial<ExperimentState> = {}): ExperimentState {
  return withDerivedMetrics({
    ...createExperimentState(),
    name: 'Speed up parser',
    metricName: 'total_ms',
    metricUnit: 'ms',
    secondaryMetrics: [{ name: 'compile_ms', unit: 'ms' }],
    results,
    ...extra,
  })
}

const RUNS = [
  result(1, 100, 'keep', 'baseline', { compile_ms: 40 }),
  result(2, 90, 'keep', 'cache tokens', { compile_ms: 35 }),
  result(3, 120, 'discard', 'inline everything', { compile_ms: 50 }),
  result(4, 0, 'crash', 'unsafe rewrite'),
  result(5, 95, 'checks_failed', 'skip validation', { compile_ms: 30 }),
  result(6, 80, 'keep', 'arena allocator', { compile_ms: 30 }),
  result(7, 85, 'discard', 'smaller buffers', { compile_ms: 31 }),
  result(8, 79, 'keep', 'branchless\nlexer', { compile_ms: 29 }),
]

test('cell widths count wide glyphs twice and joiners as zero', () => {
  assert.equal(cellWidth('abc'), 3)
  assert.equal(cellWidth('🔬 x'), 4)
  assert.equal(cellWidth('★─×'), 3)
  assert.equal(cellWidth('⚠️'), 1)
})

test('truncation keeps the width and marks the cut', () => {
  assert.equal(truncateText('hello world', 5), 'hell…')
  assert.equal(truncateText('hi', 5), 'hi')
  const line: Line = [{ text: 'abc', tone: 'text' }, { text: 'defgh', tone: 'error' }]
  const cut = truncateLine(line, 6)
  assert.equal(text(cut), 'abcde…')
  assert.equal(cut[1]!.tone, 'error')
  assert.equal(lineWidth(truncateLine(line, 100)), 8)
})

test('right hints fall back to shorter ones and fill the row', () => {
  const left: Line = [{ text: '  # commit', tone: 'muted' }]
  assert.equal(text(withRightHint(left, 40, ['/autoresearch dashboard'])), '  # commit' + ' '.repeat(7) + '/autoresearch dashboard')
  assert.equal(lineWidth(withRightHint(left, 20, ['/autoresearch dashboard', 'dashboard'])), 20)
  assert.match(text(withRightHint(left, 20, ['/autoresearch dashboard', 'dashboard'])), /dashboard$/)
})

test('confidence is green from 2.0×, yellow from 1.0×, red below', () => {
  assert.equal(confidenceTone(2.0), 'success')
  assert.equal(confidenceTone(1.99), 'warning')
  assert.equal(confidenceTone(1.0), 'warning')
  assert.equal(confidenceTone(0.4), 'error')
})

test('the dashboard has upstream summary, baseline, progress and secondary lines', () => {
  const state = session(RUNS)
  const lines = dashboardLines(state, 120, 0).map(text)
  assert.match(lines[0]!, /^ {2}Runs: 8 {2}4 kept {2}\(conf: \d+\.\d×\) {2}2 discarded {2}1 crashed {2}1 checks failed$/)
  assert.equal(lines[1], '  Baseline: ★ total_ms: 100ms #1')
  assert.equal(lines[2], '  Progress: ★ total_ms: 79ms #8 (-21.0%)')
  assert.equal(lines[3]!.trim(), 'compile_ms: 29ms -27.5%')
  assert.equal(lines[4], '')
  assert.match(lines[5]!, /^ {2}# {2}commit {2}★ total_ms +compile_ms status +description/)
  assert.match(lines[7]!, /^ {2}1 {2}c0ffee1 100ms +40ms +keep +baseline$/)
  assert.match(lines[10]!, /^ {2}4 +— +0ms +— +crash +unsafe rewrite$/)
  // Newlines in a description never break the row.
  assert.match(lines.at(-1)!, /branchless lexer$/)
  for (const line of dashboardLines(state, 120, 0)) assert.ok(lineWidth(line) <= 120)
})

test('rows and secondary metrics colour against the baseline', () => {
  const lines = dashboardLines(session(RUNS), 120, 0)
  const row = (n: number) => lines.find(line => line[1]?.text.trim() === String(n))!
  assert.equal(row(1)[3]!.tone, 'text')
  assert.equal(row(2)[3]!.tone, 'success')
  assert.equal(row(3)[3]!.tone, 'text')
  assert.equal(row(3)[4]!.tone, 'error')
  assert.equal(row(3)[5]!.tone, 'warning')
  assert.equal(row(4)[4]!.text.trim(), '—')
  assert.equal(row(4)[5]!.tone, 'error')
})

test('runs from an older segment are dimmed and marked (old)', () => {
  const state = session([result(1, 200, 'keep', 'old baseline', {}, 0), result(2, 100, 'keep', 'new baseline', {}, 1)], { currentSegment: 1 })
  const lines = dashboardLines(state, 100, 0)
  const old = lines.find(line => line[1]?.text.trim() === '1')!
  assert.equal(old[2]!.text.trim(), '(old)')
  assert.ok(old.slice(1).every(part => part.tone === 'dim' || part.tone === 'muted'))
})

test('the widget caps the table and says how many runs are hidden', () => {
  const lines = widgetLines({ state: session(RUNS), running: null, now: 0, width: 120, maxRows: 40 }).map(text)
  assert.match(lines[0]!, /^─── 🔬 autoresearch: Speed up parser ─+$/)
  assert.equal(cellWidth(lines[0]!), 120)
  assert.ok(lines.includes('  … 2 earlier runs'))
  assert.match(lines.find(line => line.includes('commit'))!, /\/autoresearch dashboard$/)
  assert.equal(lines.filter(line => /^ {2}\d /.test(line)).length, 6)
})

test('the widget shows four rows below 95 columns and shrinks to fit maxRows', () => {
  const narrow = widgetLines({ state: session(RUNS), running: null, now: 0, width: 80, maxRows: 40 }).map(text)
  assert.equal(narrow.filter(line => /^ {2}\d /.test(line)).length, 4)
  const short = widgetLines({ state: session(RUNS), running: null, now: 0, width: 120, maxRows: 12 })
  assert.ok(short.length <= 12)
})

test('the widget is compact below 60 columns and never wider than the band', () => {
  const running = { startedAt: 1_000, command: '.auto/measure.sh' }
  const lines = widgetLines({ state: session(RUNS), running, now: 13_500, width: 40, maxRows: 40 })
  assert.deepEqual(lines.map(text), ['🔬 autoresearch: Speed up parser', '8 runs 4 kept conf ' + session(RUNS).confidence!.toFixed(1) + '×', '★ 79ms -21.0% (base 100ms)', `${spinnerFrame(13_500)} running… 12s`])
  for (const width of [1, 10, 25, 59, 60, 94, 95, 200]) {
    for (const line of widgetLines({ state: session(RUNS), running, now: 13_500, width, maxRows: 40 })) assert.ok(lineWidth(line) <= width, `width ${width}`)
  }
})

test('the widget is empty with no runs, and a running line before the first result', () => {
  assert.deepEqual(widgetLines({ state: session([]), running: null, now: 0, width: 120, maxRows: 40 }), [])
  const [line] = widgetLines({ state: session([]), running: { startedAt: 0, command: '.auto/measure.sh' }, now: 3_000, width: 200, maxRows: 40 })
  assert.equal(text(line!), `🔬 ${spinnerFrame(3_000)} running… 3s │ Speed up parser │ .auto/measure.sh │ waiting for first logged result`)
})

test('the pane lists every run and the running one with spinner and elapsed time', () => {
  const lines = paneLines(session(RUNS), { startedAt: 0, command: 'x' }, 65_000, 120).map(text)
  assert.equal(lines.filter(line => /^ {2}\d /.test(line)).length, 9)
  assert.equal(lines.at(-1), `  9  ${spinnerFrame(65_000)} running… 1m 05s`)
  assert.ok(!lines.some(line => line.includes('earlier run')))
})

test('the spinner advances with the clock', () => {
  assert.notEqual(spinnerFrame(0), spinnerFrame(250))
  assert.equal(spinnerFrame(0), spinnerFrame(2_500))
})

test('the status line summarises runs, best and confidence', () => {
  const state = session(RUNS)
  assert.equal(statusText(state, null), `🔬 autoresearch · 8 runs · best total_ms 79ms (-21.0%) · conf ${state.confidence!.toFixed(1)}×`)
  assert.equal(statusText(session([]), { startedAt: 0, command: 'x' }), '🔬 autoresearch · no runs yet · running…')
  assert.equal(statusText(session([result(1, 100, 'keep', 'b')], { maxExperiments: 20 }), null), '🔬 autoresearch · 1/20 runs · best total_ms 100ms')
})
