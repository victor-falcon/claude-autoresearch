// Typed access to the mod's `$.state` values. Refs must be literals at each call
// site, so feature modules go through these helpers instead of `$.state`.
// `update*` read, change and write with `ifVersion`, retrying on a miss, so
// hooks running at once never drop each other's changes; prefer them to
// `get*` + `set*` for any read-modify-write.

import { update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type {
  AutoResumeState,
  ExperimentState,
  LastRunState,
  ModeDecisions,
  RunningExperiment,
  SessionPaths,
} from '../../types/index.d.ts'
import { createExperimentState } from '../core/state.ts'

type State$ = Pick<EngineInterface, 'state'>

export function defaultLastRun(): LastRunState {
  return { checks: null, durationSeconds: null }
}

export function defaultAutoResume(): AutoResumeState {
  return { turns: 0, experimentsThisSession: 0, pendingResume: null }
}

// enabled

export async function getEnabled($: State$): Promise<boolean> {
  return (await $.state.get({ plugin: 'claude-autoresearch', key: 'enabled' })).value ?? false
}

export async function setEnabled($: State$, value: boolean): Promise<void> {
  await $.state.set({ plugin: 'claude-autoresearch', key: 'enabled' }, value)
}

// decisions

export async function getDecisions($: State$): Promise<ModeDecisions> {
  return (await $.state.get({ plugin: 'claude-autoresearch', key: 'decisions' })).value ?? {}
}

export function updateDecisions($: State$, change: (value: ModeDecisions) => ModeDecisions): Promise<ModeDecisions> {
  return update($, { plugin: 'claude-autoresearch', key: 'decisions' }, value => change(value ?? {}))
}

// paths

export async function getPaths($: State$): Promise<SessionPaths | null> {
  return (await $.state.get({ plugin: 'claude-autoresearch', key: 'paths' })).value ?? null
}

export async function setPaths($: State$, value: SessionPaths | null): Promise<void> {
  await $.state.set({ plugin: 'claude-autoresearch', key: 'paths' }, value)
}

// experiment

export async function getExperiment($: State$): Promise<ExperimentState> {
  return (await $.state.get({ plugin: 'claude-autoresearch', key: 'experiment' })).value ?? createExperimentState()
}

export async function setExperiment($: State$, value: ExperimentState): Promise<void> {
  await $.state.set({ plugin: 'claude-autoresearch', key: 'experiment' }, value)
}

export function updateExperiment($: State$, change: (value: ExperimentState) => ExperimentState): Promise<ExperimentState> {
  return update($, { plugin: 'claude-autoresearch', key: 'experiment' }, value =>
    change(value ?? createExperimentState()),
  )
}

// running

export async function getRunning($: State$): Promise<RunningExperiment | null> {
  return (await $.state.get({ plugin: 'claude-autoresearch', key: 'running' })).value ?? null
}

export async function setRunning($: State$, value: RunningExperiment | null): Promise<void> {
  await $.state.set({ plugin: 'claude-autoresearch', key: 'running' }, value)
}

// lastRun

export async function getLastRun($: State$): Promise<LastRunState> {
  return (await $.state.get({ plugin: 'claude-autoresearch', key: 'lastRun' })).value ?? defaultLastRun()
}

export async function setLastRun($: State$, value: LastRunState): Promise<void> {
  await $.state.set({ plugin: 'claude-autoresearch', key: 'lastRun' }, value)
}

// autoResume

export async function getAutoResume($: State$): Promise<AutoResumeState> {
  return (await $.state.get({ plugin: 'claude-autoresearch', key: 'autoResume' })).value ?? defaultAutoResume()
}

export async function setAutoResume($: State$, value: AutoResumeState): Promise<void> {
  await $.state.set({ plugin: 'claude-autoresearch', key: 'autoResume' }, value)
}

export function updateAutoResume($: State$, change: (value: AutoResumeState) => AutoResumeState): Promise<AutoResumeState> {
  return update($, { plugin: 'claude-autoresearch', key: 'autoResume' }, value =>
    change(value ?? defaultAutoResume()),
  )
}
