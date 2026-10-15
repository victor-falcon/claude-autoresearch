/**
 * Experiment state: creation, reconstruction from `.auto/log.jsonl`, and the
 * session snapshot handed to before/after hooks (ported from pi-autoresearch
 * `index.ts` `reconstructState` / `buildSessionSnapshot`).
 */

import type { ExperimentState, MetricDirection, SessionPaths } from "../../types/index.d.ts";
import type { FileIO } from "./io.ts";
import { DEFAULT_DIRECTION, DEFAULT_METRIC_NAME, DEFAULT_METRIC_UNIT, reconstructJsonlState } from "./jsonl.ts";
import { computeConfidence, findBaselineMetric, findBestMetric } from "./metrics.ts";
import { readConfig, maxExperimentsFrom, workDirFrom } from "./config.ts";
import { sessionFilePath } from "./paths.ts";

export function createExperimentState(): ExperimentState {
  return {
    name: null,
    metricName: DEFAULT_METRIC_NAME,
    metricUnit: DEFAULT_METRIC_UNIT,
    bestDirection: DEFAULT_DIRECTION,
    currentSegment: 0,
    results: [],
    secondaryMetrics: [],
    baselineMetric: null,
    bestKeptMetric: null,
    confidence: null,
    maxExperiments: null,
  };
}

/**
 * Recompute the derived fields (baseline, best kept, confidence) from the
 * results. Call after any change to `results` or `currentSegment`.
 */
export function withDerivedMetrics(state: ExperimentState): ExperimentState {
  const { results, currentSegment, bestDirection } = state;
  return {
    ...state,
    baselineMetric: findBaselineMetric(results, currentSegment),
    bestKeptMetric: findBestMetric(results, currentSegment, bestDirection),
    confidence: computeConfidence(results, currentSegment, bestDirection),
  };
}

/** Experiment state from the log's text plus the configured iteration cap. */
export function experimentStateFromJsonl(jsonlContent: string, maxExperiments: number | null): ExperimentState {
  const reconstructed = reconstructJsonlState(jsonlContent);
  return withDerivedMetrics({
    ...createExperimentState(),
    name: reconstructed.name,
    metricName: reconstructed.metricName,
    metricUnit: reconstructed.metricUnit,
    bestDirection: reconstructed.bestDirection,
    currentSegment: reconstructed.currentSegment,
    results: reconstructed.results,
    secondaryMetrics: reconstructed.secondaryMetrics,
    maxExperiments,
  });
}

export interface LoadedSession {
  paths: SessionPaths;
  state: ExperimentState;
}

/**
 * Read config and log from disk and rebuild the experiment state. A log that
 * exists but cannot be read (e.g. over the mod's 4 MiB read limit) yields the
 * empty state with `logReadError` set, never a silently empty session.
 */
export async function loadSession(io: FileIO, cwd: string): Promise<LoadedSession> {
  const config = await readConfig(io, cwd);
  const workDir = workDirFrom(cwd, config);
  const logPath = await sessionFilePath(io, workDir, "log");
  const hasPersistedLog = await io.exists(logPath);
  let content = "";
  let logReadError: string | null = null;
  if (hasPersistedLog) {
    try {
      content = await io.readText(logPath);
    } catch (error) {
      logReadError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    paths: { cwd, workDir, logPath, hasPersistedLog, logReadError },
    state: experimentStateFromJsonl(content, maxExperimentsFrom(config)),
  };
}

/** Number of logged runs in the current segment. */
export function segmentRunCount(state: ExperimentState): number {
  return state.results.filter((r) => r.segment === state.currentSegment).length;
}

/** Whether `maxIterations` has been reached in the current segment. */
export function isIterationLimitReached(state: ExperimentState): boolean {
  return state.maxExperiments !== null && segmentRunCount(state) >= state.maxExperiments;
}

/** The session snapshot hooks receive on stdin (snake_case, as upstream). */
export interface SessionSnapshot {
  metric_name: string;
  metric_unit: string;
  direction: MetricDirection;
  baseline_metric: number | null;
  best_metric: number | null;
  run_count: number;
  goal: string;
}

export function buildSessionSnapshot(state: ExperimentState): SessionSnapshot {
  return {
    metric_name: state.metricName,
    metric_unit: state.metricUnit,
    direction: state.bestDirection,
    baseline_metric: state.baselineMetric,
    best_metric: findBestMetric(state.results, state.currentSegment, state.bestDirection),
    run_count: state.results.length,
    goal: state.name ?? "",
  };
}
