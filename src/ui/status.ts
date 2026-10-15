// The status line entry and the spinner clock: both follow `$.state` writes.

import type { EngineInterface, On, Timer } from 'claude-code'

import { getEnabled, getExperiment, getRunning } from '../runtime/state.ts'
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

/** Pin the summary while the mode is on; clear it when off. */
export async function syncStatus($: Ui$): Promise<void> {
  const [enabled, state, running] = await Promise.all([getEnabled($), getExperiment($), getRunning($)])
  $.ui.status(enabled ? statusText(state, running) : undefined)
  syncTicker($, running !== null)
}

export function registerStatus(on: On): void {
  on('state.set', { plugin: 'autoresearch', key: ['enabled', 'experiment', 'running'] }, async ($, e, next) => {
    const result = await next(e)
    await syncStatus($)
    return result
  }).catch(($, e, next) => next(e))
}
