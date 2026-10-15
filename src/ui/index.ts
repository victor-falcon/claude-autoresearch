import type { EngineInterface, On } from 'claude-code'

import { registerPaneScroll } from './dashboard.ts'
import { registerPane } from './pane.tsx'
import { registerStatus, syncStatus } from './status.ts'
import { registerWidget } from './widget.tsx'

export { openDashboard } from './dashboard.ts'

/**
 * The widget above the prompt, the status line and the fullscreen dashboard
 * pane. Every drawing reads `$.state`, so a tool's write redraws it; the
 * status line follows the same writes through a `state.set` hook.
 */
export function registerUi(on: On): void {
  registerWidget(on)
  registerPane(on)
  registerPaneScroll(on)
  registerStatus(on)
}

/** Session start: pin the status line for the state just reloaded. */
export async function startUi($: Pick<EngineInterface, 'clock' | 'state' | 'ui'>): Promise<void> {
  await syncStatus($)
}
