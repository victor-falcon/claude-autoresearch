import type { On, PluginState } from 'claude-code'
import { expect, test } from 'claude-code/testing'

// The values the mod writes to `$.state`, captured as they pass beneath it.
type Written = Partial<PluginState['autoresearch']>

function captureState(on: On): Written {
  const written: Record<string, unknown> = {}
  on('state.set', ($, e, next) => {
    if (e.plugin === 'autoresearch') written[e.key] = e.value
    return next(e)
  })
  return written as Written
}

// An in-memory file system answering the `fs.*` events beneath the mod.
const FILES: Record<string, string> = {
  '/work/.auto/log.jsonl': [
    '{"type":"config","name":"Speed up parser","metricName":"total_ms","metricUnit":"ms","bestDirection":"lower"}',
    '{"run":1,"commit":"aaa1111","metric":100,"metrics":{"compile_ms":40},"status":"keep","description":"baseline","timestamp":1,"segment":0,"confidence":null}',
    '{"type":"hook","stage":"after","exit_code":0,"duration_ms":3,"stdout_bytes":0,"timed_out":false}',
    '{"run":2,"commit":"bbb2222","metric":80,"metrics":{"compile_ms":30},"status":"keep","description":"cache","timestamp":2,"segment":0,"confidence":null}',
  ].join('\n') + '\n',
  '/work/.auto/config.json': '{"maxIterations":5}',
}

test('session start rebuilds the experiment state from .auto/log.jsonl', async ($, on) => {
  const state = captureState(on)
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', ($, e) => ({ value: e.path in FILES }))
  on('fs.read', ($, e) => {
    const text = FILES[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/work', surface: null, isInteractive: false })

  const experiment = state.experiment
  expect(experiment?.name).toBe('Speed up parser')
  expect(experiment?.metricName).toBe('total_ms')
  expect(experiment?.results.length).toBe(2)
  expect(experiment?.baselineMetric).toBe(100)
  expect(experiment?.bestKeptMetric).toBe(80)
  expect(experiment?.maxExperiments).toBe(5)
  expect(experiment?.secondaryMetrics).toEqual([{ name: 'compile_ms', unit: 'ms' }])

  expect(state.paths).toEqual({
    cwd: '/work',
    workDir: '/work',
    logPath: '/work/.auto/log.jsonl',
    hasPersistedLog: true,
    logReadError: null,
  })
  // A persisted log never switches the mode on by itself.
  expect(state.enabled ?? false).toBe(false)

  expect(state.running).toBe(null)
  expect(state.lastRun).toEqual({ checks: null, durationSeconds: null })
  expect(state.autoResume).toEqual({ turns: 0, experimentsThisSession: 0, pendingResume: null })
})

test('session start without a log leaves an empty experiment', async ($, on) => {
  const state = captureState(on)
  on('session.cwd', () => ({ value: '/empty' }))
  on('fs.exists', () => ({ value: false }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/empty', surface: null, isInteractive: false })

  const experiment = state.experiment
  expect(experiment?.results).toEqual([])
  expect(experiment?.name).toBe(null)
})

test('session start still completes when the session files cannot be read', async ($, on) => {
  const state = captureState(on)
  on('session.cwd', () => ({ value: '/broken' }))
  on('fs.exists', () => {
    throw new Error('EACCES')
  })
  on('ui.log', () => ({ value: undefined }))
  let reachedEngine = false
  on('session.start', ($, e) => {
    reachedEngine = true
    return { cwd: e.cwd }
  })

  await $.session.start({ cwd: '/broken', surface: null, isInteractive: false })

  expect(reachedEngine).toBe(true)
  expect(state.running).toBe(null)
  expect(state.experiment).toBe(undefined)
})
