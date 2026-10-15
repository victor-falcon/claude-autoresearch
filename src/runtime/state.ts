// Typed access to the mod's `$.state` values. Refs must be literals at each call
// site, so feature modules go through these helpers instead of `$.state`.

import type { EngineInterface } from 'claude-code'

import type {
  AutoResumeState,
  AutoresearchModeState,
  ExperimentState,
  LastRunState,
  RunningExperiment,
} from '../../types/index.d.ts'
import { createExperimentState } from '../core/state.ts'

type State$ = Pick<EngineInterface, 'state'>

export function defaultMode(): AutoresearchModeState {
  return { enabled: false, cwd: null, workDir: null, decisions: {} }
}

export function defaultLastRun(): LastRunState {
  return { checks: null, durationSeconds: null }
}

export function defaultAutoResume(): AutoResumeState {
  return { turns: 0, experimentsThisSession: 0, pendingMessage: null }
}

export async function getMode($: State$): Promise<AutoresearchModeState> {
  return (await $.state.get({ plugin: 'claude-autoresearch', key: 'mode' })).value ?? defaultMode()
}

export async function setMode($: State$, value: AutoresearchModeState): Promise<void> {
  await $.state.set({ plugin: 'claude-autoresearch', key: 'mode' }, value)
}

export async function getExperiment($: State$): Promise<ExperimentState> {
  return (await $.state.get({ plugin: 'claude-autoresearch', key: 'experiment' })).value ?? createExperimentState()
}

export async function setExperiment($: State$, value: ExperimentState): Promise<void> {
  await $.state.set({ plugin: 'claude-autoresearch', key: 'experiment' }, value)
}

export async function getRunning($: State$): Promise<RunningExperiment | null> {
  return (await $.state.get({ plugin: 'claude-autoresearch', key: 'running' })).value ?? null
}

export async function setRunning($: State$, value: RunningExperiment | null): Promise<void> {
  await $.state.set({ plugin: 'claude-autoresearch', key: 'running' }, value)
}

export async function getLastRun($: State$): Promise<LastRunState> {
  return (await $.state.get({ plugin: 'claude-autoresearch', key: 'lastRun' })).value ?? defaultLastRun()
}

export async function setLastRun($: State$, value: LastRunState): Promise<void> {
  await $.state.set({ plugin: 'claude-autoresearch', key: 'lastRun' }, value)
}

export async function getAutoResume($: State$): Promise<AutoResumeState> {
  return (await $.state.get({ plugin: 'claude-autoresearch', key: 'autoResume' })).value ?? defaultAutoResume()
}

export async function setAutoResume($: State$, value: AutoResumeState): Promise<void> {
  await $.state.set({ plugin: 'claude-autoresearch', key: 'autoResume' }, value)
}
