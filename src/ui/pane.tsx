// The fullscreen dashboard pane: every run, scrollable, with a live spinner
// while an experiment runs. The engine scrolls it (arrows, PgUp/PgDn,
// Home/End, the wheel); j/k/u/d/g/G/q are hotkey Buttons of the pane, and
// every row is a keyed Box so a key can scroll a given row to the top.

import type { On } from 'claude-code'

import { getExperiment, getRunning } from '../runtime/state.ts'
import { closeDashboard, DASHBOARD_PANE, notePaneLayout, pageRows, paneRowKey, paneScrollInfo, scrollPaneBy, scrollPaneToEdge } from './dashboard.ts'
import { cellWidth, paneLines, sessionTitle, truncateText } from './format.ts'
import { lineText, toneProps } from './lines.tsx'

/** Rows the pane draws above the table: the title and the keys. */
const HEADER_ROWS = 2

export function registerPane(on: On): void {
  on('ui.render', { component: 'Pane', requestId: DASHBOARD_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const width = Math.max(4, e.props.bodyColumns)
    const [state, running, now] = await Promise.all([getExperiment($), getRunning($), $.clock.now()])
    const lines = paneLines(state, running, now, width)
    notePaneLayout(e.props.scroll.offset, e.props.scroll.bodyRows, lines.length + HEADER_ROWS)

    const info = paneScrollInfo()
    const position = info ? ` ${info.first}-${info.last}/${info.total}` : ''
    const isWide = width >= 60
    const key = (hotkey: string, label: string, onPress: () => Promise<void>) => (
      <Button key={`key-${hotkey}`} plain hotkey={hotkey} label={label} onPress={onPress} />
    )

    return (
      <Box flexDirection="column">
        <Box key={paneRowKey(0)} flexDirection="row" justifyContent="space-between">
          <Text {...toneProps('title', true)} wrap="truncate">
            {truncateText(` ${sessionTitle(state)}`, Math.max(1, width - cellWidth(position)))}
          </Text>
          <Text dimColor>{position}</Text>
        </Box>
        <Box key={paneRowKey(1)} flexDirection="row" columnGap={isWide ? 2 : 1} paddingLeft={1}>
          {key('j', '↓', () => scrollPaneBy($, 1))}
          {key('k', '↑', () => scrollPaneBy($, -1))}
          {key('d', isWide ? 'page ↓' : 'pg↓', () => scrollPaneBy($, pageRows()))}
          {key('u', isWide ? 'page ↑' : 'pg↑', () => scrollPaneBy($, -pageRows()))}
          {key('g', 'top/end', () => scrollPaneToEdge($))}
          {key('q', 'close', () => closeDashboard($))}
        </Box>
        {lines.map((line, i) => <Box key={paneRowKey(HEADER_ROWS + i)}>{lineText(Text, line)}</Box>)}
      </Box>
    )
  })
}
