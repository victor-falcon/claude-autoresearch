// The widget above the prompt: the dashboard table while autoresearch mode
// is on, redrawn as the tools write the state (every read subscribes).

import type { On } from 'claude-code'

import { getEnabled, getExperiment, getRunning } from '../runtime/state.ts'
import { widgetLines } from './format.ts'
import { lineRows } from './lines.tsx'

export function registerWidget(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await getEnabled($))) return next(e)

    const [state, running, now] = await Promise.all([getExperiment($), getRunning($), $.clock.now()])
    const lines = widgetLines({ state, running, now, width: e.props.bodyColumns, maxRows: e.props.maxRows })
    if (lines.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    return <Box flexDirection="column">{lineRows(Text, lines)}</Box>
  })
}
