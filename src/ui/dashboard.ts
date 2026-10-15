// The fullscreen dashboard pane: opening it (`/autoresearch dashboard`) and
// the keys that scroll it. Drawn by `pane.tsx`.

import type { EngineInterface, On } from 'claude-code'

import { getEnabled, getExperiment } from '../runtime/state.ts'

export const DASHBOARD_PANE = 'autoresearch-dashboard'

/**
 * Where the pane's window stands over its tree: the engine owns it, this
 * copy follows the last draw and every move so the j/k/u/d keys can step
 * from it. View state only, so it lives in the module (a reload resets it).
 */
const scroll = { offset: 0, bodyRows: 0, contentRows: 0 }

const maxOffset = () => Math.max(0, scroll.contentRows - scroll.bodyRows)
const clamp = (offset: number) => Math.min(maxOffset(), Math.max(0, offset))

/** What the last draw of the pane saw. */
export function notePaneLayout(offset: number, bodyRows: number, contentRows: number): void {
  scroll.bodyRows = bodyRows
  scroll.contentRows = contentRows
  scroll.offset = clamp(offset)
}

export function paneScrollInfo(): { first: number; last: number; total: number } | null {
  if (scroll.contentRows <= scroll.bodyRows || scroll.bodyRows === 0) return null
  return { first: scroll.offset + 1, last: Math.min(scroll.offset + scroll.bodyRows, scroll.contentRows), total: scroll.contentRows }
}

type Scroll$ = Pick<EngineInterface, 'ui'>

/** The key of the pane's tree row `row` (0 at the top), each row keyed. */
export function paneRowKey(row: number): string {
  return `row-${row}`
}

/** Move the window by `rows` (negative: up), as j/k/u/d do: the row that is
 * to be first is scrolled to the top of the window. */
export async function scrollPaneBy($: Scroll$, rows: number): Promise<void> {
  const target = clamp(scroll.offset + rows)
  if (target === scroll.offset) return
  await $.ui.scroll({ in: DASHBOARD_PANE, to: { key: paneRowKey(target) }, block: 'start' })
}

/** One page: the window's rows less one, so a row stays for context. */
export function pageRows(): number {
  return Math.max(1, scroll.bodyRows - 1)
}

/** g / G: one hotkey (shift+g is g), so it jumps to the far end from here. */
export async function scrollPaneToEdge($: Scroll$): Promise<void> {
  await $.ui.scroll({ in: DASHBOARD_PANE, to: scroll.offset > 0 ? 'start' : 'end' })
}

/** Follow every move of the pane's window, the person's and the keys'. */
export function registerPaneScroll(on: On): void {
  on('ui.scroll', { component: 'Pane', requestId: DASHBOARD_PANE }, ($, e, next) => {
    scroll.bodyRows = e.bodyRows
    scroll.contentRows = e.contentRows
    scroll.offset = clamp(e.offset)
    return next(e)
  }).catch(($, e, next) => next(e))
}

/**
 * `/autoresearch dashboard`: open the scrollable dashboard of every run.
 * Returns the text shown to the user (upstream notified the same cases).
 */
export async function openDashboard($: Pick<EngineInterface, 'state' | 'ui'>, _args: string): Promise<string> {
  if (!(await getEnabled($))) return 'Autoresearch mode is not active.'
  const state = await getExperiment($)
  if (state.results.length === 0) return 'No experiments yet.'

  scroll.offset = 0
  const opened = await $.ui.open({
    id: DASHBOARD_PANE,
    title: state.name ? `autoresearch: ${state.name}` : 'autoresearch',
    focus: true,
    closeOnEscape: true,
    // As tall as the layout spares: the whole table when it fits.
    rows: state.results.length + 16,
  })
  if (!opened.isPlaced) return `The dashboard could not be shown here (${opened.reason}).`
  return 'Dashboard opened: ↑↓/j/k scroll, PgUp/PgDn/u/d page, g/G top/bottom, Esc/q close.'
}

export async function closeDashboard($: Scroll$): Promise<void> {
  await $.ui.close({ id: DASHBOARD_PANE })
}
