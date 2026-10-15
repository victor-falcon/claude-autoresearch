// The status line entry and the spinner clock: both follow `$.state` writes.

import type { EngineInterface, On, Timer } from 'claude-code'

import { getEnabled, getExperiment, getRunning } from '../runtime/state.ts'
import { closeDashboard } from './dashboard.ts'
import { SPINNER_INTERVAL_MS, statusText } from './format.ts'

type Ui$ = Pick<EngineInterface, 'clock' | 'state' | 'ui'>

/** Redraws the widget and the pane while an experiment runs. */
let ticker: Timer | null = null

function syncTicker($: Ui$, isRunning: boolean): void {
  if (isRunning && ticker === null) {
    ticker = $.clock.every(SPINNER_INTERVAL_MS, () => $.ui.invalidate('ui.render'))
  } else if (!isRunning && ticker !== null) {
    ticker.cancel()
    ticker = null
  }
}

/**
 * Pin the summary while the mode is on; clear it when off. Never throws: a
 * view must not fail the session start or the tool write that triggered it.
 */
export async function syncStatus($: Ui$): Promise<void> {
  try {
    const [enabled, state, running] = await Promise.all([getEnabled($), getExperiment($), getRunning($)])
    $.ui.status(enabled ? statusText(state, running) : undefined)
    syncTicker($, enabled && running !== null)
  } catch (error) {
    $.ui.log(`autoresearch: could not update the status line: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function registerStatus(on: On): void {
  on('state.set', { plugin: 'autoresearch', key: ['enabled', 'experiment', 'running'] }, async ($, e, next) => {
    const result = await next(e)
    await syncStatus($)
    // The dashboard goes with the mode, as upstream's overlay does.
    if (e.key === 'enabled' && e.value === false && e.previous !== false) await closeDashboard($).catch(() => undefined)
    return result
  }).catch(($, e, next) => next(e))
}
