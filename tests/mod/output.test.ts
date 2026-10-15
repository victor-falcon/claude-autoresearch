import { expect, test } from 'claude-code/testing'

import { RollingTail, cutAtBoundary, formatSize, truncateTail } from '../../src/tools/output.ts'
import { isAutoresearchShCommand } from '../../src/core/metrics.ts'
import { REVERT_SCRIPT, commitMessage } from '../../src/tools/git.ts'

test('truncateTail keeps the last lines within both limits, like pi', () => {
  const lines = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join('\n')
  const byLines = truncateTail(lines, 10, 4096)
  expect(byLines).toEqual({ content: lines.split('\n').slice(5).join('\n'), truncated: true, truncatedBy: 'lines', totalLines: 15, outputLines: 10 })

  const byBytes = truncateTail(['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)].join('\n'), 10, 64)
  expect(byBytes.truncatedBy).toBe('bytes')
  expect(byBytes.content).toBe(['b'.repeat(30), 'c'.repeat(30)].join('\n'))

  const oneLongLine = truncateTail('x'.repeat(100), 10, 8)
  expect(oneLongLine.content).toBe('x'.repeat(8))

  expect(truncateTail('short\noutput', 10, 4096).truncated).toBe(false)
})

test('RollingTail drops old output at a line start', () => {
  const tail = new RollingTail(16)
  tail.push('first line\nsecond line\n')
  tail.push('third\n')
  expect(tail.toString()).toBe('third\n')
  expect(tail.totalBytes).toBe(29)
})

test('cutAtBoundary cuts at the last newline, else at a whole character', () => {
  expect(cutAtBoundary('ab\ncd\nef', 7)).toBe('ab\ncd\n')
  expect(cutAtBoundary('ééé', 5)).toBe('éé')
  expect(formatSize(4096)).toBe('4.0KB')
  expect(formatSize(512)).toBe('512B')
})

test('only the benchmark script passes the measure.sh guard', () => {
  expect(isAutoresearchShCommand('bash .auto/measure.sh')).toBe(true)
  expect(isAutoresearchShCommand('FOO=1 time ./.auto/measure.sh --fast')).toBe(true)
  expect(isAutoresearchShCommand('evil.py; .auto/measure.sh')).toBe(false)
})

test('commit message and revert script match upstream', () => {
  expect(commitMessage('faster', 'keep', 'total_ms', 80, { compile_ms: 3 })).toBe(
    'faster\n\nResult: {"status":"keep","total_ms":80,"compile_ms":3}',
  )
  expect(REVERT_SCRIPT).toContain("git checkout -- . ':(exclude,glob)**/.auto' ':(exclude,glob)**/.auto/**' ':(exclude,glob)**/autoresearch.*' ':(exclude,glob)**/autoresearch.*/**'")
  expect(REVERT_SCRIPT).toContain("git clean -fd -e '.auto' -e '**/.auto/**' -e 'autoresearch.*' -e '**/autoresearch.*/**' 2>/dev/null")
})
