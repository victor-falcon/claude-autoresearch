// Pure dashboard formatting: the widget above the prompt, the fullscreen pane
// and the status line, as lines of toned segments the views turn into Text.
// Ported from pi-autoresearch `index.ts` (`renderDashboardLines`, the widget
// in `updateWidget`, `openFullscreenDashboard`). No `$`, no Node.

import type { ExperimentResult, ExperimentState, RunningExperiment } from '../../types/index.d.ts'
import { currentResults, findBaselineMetric, findBaselineRunNumber, findBaselineSecondary, formatElapsed, formatNum, isBetter } from '../core/metrics.ts'

/** What a segment means; each view maps it to the surface's colours. */
export type Tone = 'text' | 'muted' | 'dim' | 'accent' | 'title' | 'border' | 'success' | 'warning' | 'error'

export type Segment = { text: string; tone: Tone; bold?: boolean }

/** One drawn row: segments laid out left to right, never wider than asked. */
export type Line = Segment[]

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** How often a running experiment redraws its spinner and elapsed time. */
export const SPINNER_INTERVAL_MS = 250

/** Widget rows of the results table: fewer on a narrow terminal (upstream). */
const WIDGET_ROWS = 6
const WIDGET_ROWS_NARROW = 4
const NARROW_TABLE_WIDTH = 95
/** Below this the widget drops the table for a compact summary. */
const COMPACT_WIDTH = 60

export const DASHBOARD_HINTS = ['/autoresearch dashboard', 'dashboard']

const seg = (text: string, tone: Tone = 'text', bold?: boolean): Segment => (bold ? { text, tone, bold } : { text, tone })

// ---------------------------------------------------------------------------
// Cell widths
// ---------------------------------------------------------------------------

/** Terminal cells one code point takes: 2 for wide (CJK, emoji), 0 for joiners. */
function codePointWidth(cp: number): number {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x300 && cp <= 0x36f)) return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  ) {
    return 2
  }
  return 1
}

export function cellWidth(text: string): number {
  let width = 0
  for (const char of text) width += codePointWidth(char.codePointAt(0)!)
  return width
}

export function lineWidth(line: Line): number {
  return line.reduce((sum, part) => sum + cellWidth(part.text), 0)
}

/** `text` cut to `width` cells, ending in `…` when cut. */
export function truncateText(text: string, width: number): string {
  if (width <= 0) return ''
  if (cellWidth(text) <= width) return text
  let out = ''
  let used = 0
  for (const char of text) {
    const w = codePointWidth(char.codePointAt(0)!)
    if (used + w > width - 1) break
    out += char
    used += w
  }
  return `${out}…`
}

/** `line` cut to `width` cells, the last kept segment ending in `…`. */
export function truncateLine(line: Line, width: number): Line {
  if (lineWidth(line) <= width) return line
  const out: Line = []
  let used = 0
  for (const part of line) {
    const w = cellWidth(part.text)
    if (used + w <= width - 1) {
      out.push(part)
      used += w
      continue
    }
    const cut = truncateText(part.text, width - used)
    if (cut) out.push({ ...part, text: cut })
    break
  }
  return out
}

/** Pad (or cut) plain text to exactly `width` cells. */
export function padText(text: string, width: number): string {
  const fitted = cellWidth(text) > width ? truncateText(text, width) : text
  return fitted + ' '.repeat(Math.max(0, width - cellWidth(fitted)))
}

/**
 * `left` with the first hint that fits right-aligned on the same row (upstream
 * `appendRightAlignedAdaptiveHint`); `left` is cut to make room.
 */
export function withRightHint(left: Line, width: number, hints: readonly string[]): Line {
  for (const hint of hints) {
    const hintWidth = cellWidth(hint) + 1
    if (hintWidth > width) continue
    const fitted = truncateLine(left, Math.max(0, width - hintWidth))
    const gap = width - lineWidth(fitted) - hintWidth
    return [...fitted, seg(' '.repeat(gap + 1)), seg(hint, 'dim')]
  }
  return truncateLine(left, width)
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** Green ≥2.0×, yellow 1.0–2.0×, red below: how real the best improvement is. */
export function confidenceTone(confidence: number): Tone {
  return confidence >= 2.0 ? 'success' : confidence >= 1.0 ? 'warning' : 'error'
}

export function spinnerFrame(now: number): string {
  return SPINNER[Math.floor(now / SPINNER_INTERVAL_MS) % SPINNER.length]!
}

function signedPercent(value: number, base: number): string {
  const pct = ((value - base) / base) * 100
  return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function sessionTitle(state: ExperimentState): string {
  return `🔬 autoresearch${state.name ? `: ${oneLine(state.name)}` : ''}`
}

/** The best kept run of the current segment: value, 1-based index, metrics. */
function bestKeptRun(state: ExperimentState): { metric: number; index: number; metrics: Record<string, number> } | null {
  let best: { metric: number; index: number; metrics: Record<string, number> } | null = null
  state.results.forEach((r, i) => {
    if (r.segment !== state.currentSegment || r.status !== 'keep' || r.metric <= 0) return
    // Ties go to the latest run, as upstream's backward scan does.
    if (best === null || !isBetter(best.metric, r.metric, state.bestDirection)) {
      best = { metric: r.metric, index: i + 1, metrics: r.metrics ?? {} }
    }
  })
  return best
}

function statusTone(result: ExperimentResult): Tone {
  if (result.status === 'keep') return 'success'
  if (result.status === 'crash' || result.status === 'checks_failed') return 'error'
  return 'warning'
}

/** `─── 🔬 autoresearch: name ─────…` across the whole width. */
export function titleRule(state: ExperimentState, width: number): Line {
  const title = truncateText(sessionTitle(state), Math.max(0, width - 5))
  const fill = Math.max(0, width - 3 - 1 - cellWidth(title) - 1)
  return truncateLine([seg('───', 'border'), seg(` ${title} `, 'title'), seg('─'.repeat(fill), 'border')], width)
}

/** `  7  ⠋ running… 12s`: the row the next run will take. */
export function runningRow(state: ExperimentState, running: RunningExperiment, now: number, width: number): Line {
  const elapsed = formatElapsed(Math.max(0, now - running.startedAt))
  return truncateLine(
    [seg('  '), seg(String(state.results.length + 1).padEnd(3), 'dim'), seg(`${spinnerFrame(now)} running… ${elapsed}`, 'warning')],
    width,
  )
}

/** The one-line widget while the first experiment runs (upstream). */
export function firstRunLine(state: ExperimentState, running: RunningExperiment, now: number, width: number): Line {
  const elapsed = formatElapsed(Math.max(0, now - running.startedAt))
  return truncateLine(
    [
      seg('🔬', 'title'),
      seg(` ${spinnerFrame(now)} running… ${elapsed}`, 'warning'),
      ...(state.name ? [seg(` │ ${oneLine(state.name)}`, 'dim')] : []),
      seg(` │ ${oneLine(running.command)}`, 'dim'),
      seg(' │ waiting for first logged result', 'dim'),
    ],
    width,
  )
}

// ---------------------------------------------------------------------------
// The dashboard table (upstream renderDashboardLines)
// ---------------------------------------------------------------------------

/** The runs summary: `Runs: 12  8 kept  (conf: 2.3×)  3 discarded  1 crashed`. */
export function summaryLine(state: ExperimentState, width: number): Line {
  const cur = currentResults(state.results, state.currentSegment)
  const count = (status: ExperimentResult['status']) => cur.filter(r => r.status === status).length
  const discarded = count('discard')
  const crashed = count('crash')
  const checksFailed = count('checks_failed')
  const runs = state.maxExperiments === null ? String(state.results.length) : `${state.results.length}/${state.maxExperiments}`
  return truncateLine(
    [
      seg('  Runs: ', 'muted'),
      seg(runs),
      seg(`  ${count('keep')} kept`, 'success'),
      ...(state.confidence !== null ? [seg(`  (conf: ${state.confidence.toFixed(1)}×)`, confidenceTone(state.confidence))] : []),
      ...(discarded > 0 ? [seg(`  ${discarded} discarded`, 'warning')] : []),
      ...(crashed > 0 ? [seg(`  ${crashed} crashed`, 'error')] : []),
      ...(checksFailed > 0 ? [seg(`  ${checksFailed} checks failed`, 'error')] : []),
    ],
    width,
  )
}

/** Baseline, progress and the best run's secondary metrics. */
function headlineLines(state: ExperimentState, width: number): Line[] {
  const lines: Line[] = [summaryLine(state, width)]
  const baseline = state.baselineMetric
  const baselineRun = findBaselineRunNumber(state.results, state.currentSegment)
  lines.push(
    truncateLine(
      [seg('  Baseline: ', 'muted'), seg(`★ ${state.metricName}: ${formatNum(baseline, state.metricUnit)}${baselineRun === null ? '' : ` #${baselineRun}`}`, 'muted')],
      width,
    ),
  )

  const best = bestKeptRun(state)
  if (best === null) return lines

  const progress: Line = [
    seg('  Progress: ', 'muted'),
    seg(`★ ${state.metricName}: ${formatNum(best.metric, state.metricUnit)}`, 'warning', true),
    seg(` #${best.index}`, 'dim'),
  ]
  if (baseline !== null && baseline !== 0 && best.metric !== baseline) {
    progress.push(seg(` (${signedPercent(best.metric, baseline)})`, isBetter(best.metric, baseline, state.bestDirection) ? 'success' : 'error'))
  }
  lines.push(truncateLine(progress, width))

  // Secondary metrics of the best run, flow-wrapped under the progress value.
  const baselineSec = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics)
  const parts: Line[] = []
  for (const metric of state.secondaryMetrics) {
    const value = best.metrics[metric.name]
    if (value === undefined) continue
    const part: Line = [seg(`${metric.name}: ${formatNum(value, metric.unit)}`, 'muted')]
    const base = baselineSec[metric.name]
    if (base !== undefined && base !== 0 && value !== base) {
      part.push(seg(` ${signedPercent(value, base)}`, value <= base ? 'success' : 'error'))
    }
    parts.push(part)
  }
  const indent = ' '.repeat(14)
  const room = width - indent.length
  let row: Line = []
  for (const part of parts) {
    if (row.length > 0 && lineWidth(row) + 2 + lineWidth(part) > room) {
      lines.push(truncateLine([seg(indent), ...row], width))
      row = []
    }
    row = row.length > 0 ? [...row, seg('  '), ...part] : part
  }
  if (row.length > 0) lines.push(truncateLine([seg(indent), ...row], width))
  return lines
}

/**
 * The results table under the headline, the last `maxRows` runs (all with
 * 0), with `… N earlier runs` above when some are hidden. `hints` go
 * right-aligned on the header row.
 */
export function tableLines(state: ExperimentState, width: number, maxRows: number, hints: readonly string[] = []): Line[] {
  const lines: Line[] = []
  const total = state.results.length
  const start = maxRows <= 0 ? 0 : Math.max(0, total - maxRows)
  const rows = state.results.slice(start)

  // Only secondary columns with a value in a shown row.
  const secMetrics = state.secondaryMetrics.filter(sm => rows.some(r => (r.metrics ?? {})[sm.name] !== undefined))
  const primaryLabel = `★ ${state.metricName || 'metric'}`
  const col = { idx: 3, commit: 8, primary: Math.max(11, Math.min(Math.floor(width * 0.25), cellWidth(primaryLabel) + 1)), status: 15 }
  const minDescW = Math.max(10, Math.floor(width * 0.25))
  const fixedW = col.idx + col.commit + col.primary + col.status + 6
  const secWidths = secMetrics.map(sm => {
    let w = cellWidth(sm.name)
    for (const r of rows) {
      const v = (r.metrics ?? {})[sm.name]
      if (v !== undefined) w = Math.max(w, cellWidth(formatNum(v, sm.unit)))
    }
    return w + 1
  })
  // Drop secondary columns from the right until the description keeps its room.
  let shown = secMetrics.length
  const secTotal = () => secWidths.slice(0, shown).reduce((a, b) => a + b, 0)
  while (shown > 0 && secTotal() > width - fixedW - minDescW) shown--
  const descW = Math.max(minDescW, width - fixedW - secTotal())

  const header: Line = [
    seg('  '),
    seg('#'.padEnd(col.idx), 'muted'),
    seg('commit'.padEnd(col.commit), 'muted'),
    seg(padText(truncateText(primaryLabel, col.primary - 1), col.primary), 'warning', true),
    ...secMetrics.slice(0, shown).map((sm, i) => seg(padText(sm.name, secWidths[i]!), 'muted')),
    seg('status'.padEnd(col.status), 'muted'),
    seg('description', 'muted'),
  ]
  lines.push(hints.length > 0 ? withRightHint(header, width, hints) : truncateLine(header, width))
  lines.push(truncateLine([seg('  '), seg('─'.repeat(Math.max(0, width - 4)), 'border')], width))

  if (start > 0) lines.push(truncateLine([seg('  '), seg(`… ${start} earlier run${start === 1 ? '' : 's'}`, 'dim')], width))

  const baselinePrimary = findBaselineMetric(state.results, state.currentSegment)
  const baselineSecondary = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics)
  const baselineIndex = state.results.findIndex(r => r.segment === state.currentSegment)

  for (let i = start; i < total; i++) {
    const r = state.results[i]!
    const isOld = r.segment !== state.currentSegment
    const isBaseline = !isOld && i === baselineIndex

    let primaryTone: Tone = isOld ? 'dim' : 'text'
    if (!isOld && !isBaseline && baselinePrimary !== null && r.status === 'keep' && r.metric > 0) {
      if (isBetter(r.metric, baselinePrimary, state.bestDirection)) primaryTone = 'success'
      else if (r.metric !== baselinePrimary) primaryTone = 'error'
    }
    const commit = isOld ? '(old)' : r.status !== 'keep' ? '—'.padStart(Math.ceil(col.commit / 2)) : r.commit

    const row: Line = [
      seg('  '),
      seg(String(i + 1).padEnd(col.idx), 'dim'),
      seg(padText(commit, col.commit), isOld ? 'dim' : 'accent'),
      seg(padText(formatNum(r.metric, state.metricUnit), col.primary), primaryTone, !isOld),
    ]
    secMetrics.slice(0, shown).forEach((sm, si) => {
      const value = (r.metrics ?? {})[sm.name]
      if (value === undefined) {
        row.push(seg(padText('—', secWidths[si]!), 'dim'))
        return
      }
      let tone: Tone = 'dim'
      if (!isOld) {
        const base = baselineSecondary[sm.name]
        if (isBaseline) tone = 'text'
        else if (base !== undefined && base !== 0) tone = value <= base ? 'success' : 'error'
      }
      row.push(seg(padText(formatNum(value, sm.unit), secWidths[si]!), tone))
    })
    row.push(seg(padText(r.status, col.status), isOld ? 'dim' : statusTone(r)), seg(truncateText(oneLine(r.description), descW), 'muted'))
    lines.push(truncateLine(row, width))
  }
  return lines
}

/** Upstream `renderDashboardLines`: headline, a blank row, then the table. */
export function dashboardLines(state: ExperimentState, width: number, maxRows: number, hints: readonly string[] = []): Line[] {
  if (state.results.length === 0) return [[seg('  '), seg('No experiments yet.', 'dim')]]
  return [...headlineLines(state, width), [], ...tableLines(state, width, maxRows, hints)]
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export type WidgetInput = {
  state: ExperimentState
  running: RunningExperiment | null
  now: number
  /** Cells across the band. */
  width: number
  /** Rows the band may take before it scrolls. */
  maxRows: number
}

/** The compact widget for narrow bands: title, summary, best, spinner. */
function compactWidget({ state, running, now, width }: WidgetInput): Line[] {
  const lines: Line[] = [truncateLine([seg(sessionTitle(state), 'title')], width)]
  const runs = state.maxExperiments === null ? `${state.results.length}` : `${state.results.length}/${state.maxExperiments}`
  const kept = currentResults(state.results, state.currentSegment).filter(r => r.status === 'keep').length
  lines.push(
    truncateLine(
      [
        seg(`${runs} runs `, 'muted'),
        seg(`${kept} kept`, 'success'),
        ...(state.confidence !== null ? [seg(` conf ${state.confidence.toFixed(1)}×`, confidenceTone(state.confidence))] : []),
      ],
      width,
    ),
  )
  const best = bestKeptRun(state)
  if (best !== null) {
    const line: Line = [seg('★ ', 'warning'), seg(formatNum(best.metric, state.metricUnit), 'warning', true)]
    const baseline = state.baselineMetric
    if (baseline !== null && baseline !== 0 && best.metric !== baseline) {
      line.push(seg(` ${signedPercent(best.metric, baseline)}`, isBetter(best.metric, baseline, state.bestDirection) ? 'success' : 'error'))
    }
    line.push(seg(` (base ${formatNum(baseline, state.metricUnit)})`, 'dim'))
    lines.push(truncateLine(line, width))
  }
  if (running) lines.push(truncateLine([seg(`${spinnerFrame(now)} running… ${formatElapsed(Math.max(0, now - running.startedAt))}`, 'warning')], width))
  return lines
}

/**
 * The widget above the prompt: nothing until there is a result or a run, the
 * running line before the first result, the dashboard after (upstream).
 * Rows of the table shrink so the widget fits `maxRows` when it can.
 */
export function widgetLines(input: WidgetInput): Line[] {
  const { state, running, now, width, maxRows } = input
  if (width <= 0) return []
  if (state.results.length === 0) return running ? [firstRunLine(state, running, now, width)] : []
  if (width < COMPACT_WIDTH) return compactWidget(input)

  const wanted = width < NARROW_TABLE_WIDTH ? WIDGET_ROWS_NARROW : WIDGET_ROWS
  const build = (rows: number) => {
    const lines = [titleRule(state, width), ...dashboardLines(state, width, rows, DASHBOARD_HINTS)]
    if (running) lines.push(runningRow(state, running, now, width))
    return lines
  }
  let rows = Math.min(wanted, state.results.length)
  let lines = build(rows)
  while (rows > 1 && lines.length > maxRows) lines = build(--rows)
  return lines
}

/** The fullscreen pane's body: every run, then the running row. */
export function paneLines(state: ExperimentState, running: RunningExperiment | null, now: number, width: number): Line[] {
  const lines = dashboardLines(state, width, 0)
  if (running) lines.push(runningRow(state, running, now, width))
  return lines
}

/**
 * The status line under the prompt while the mode is on: run count, best
 * against baseline, confidence, and whether a run is going.
 */
export function statusText(state: ExperimentState, running: RunningExperiment | null): string {
  const parts = ['🔬 autoresearch']
  const n = state.results.length
  if (n === 0) parts.push('no runs yet')
  else parts.push(`${state.maxExperiments === null ? n : `${n}/${state.maxExperiments}`} run${n === 1 && state.maxExperiments === null ? '' : 's'}`)
  const best = state.bestKeptMetric
  const baseline = state.baselineMetric
  if (best !== null) {
    let text = `best ${state.metricName} ${formatNum(best, state.metricUnit)}`
    if (baseline !== null && baseline !== 0 && best !== baseline) text += ` (${signedPercent(best, baseline)})`
    parts.push(text)
  }
  if (state.confidence !== null) parts.push(`conf ${state.confidence.toFixed(1)}×`)
  if (running) parts.push('running…')
  return parts.join(' · ')
}
