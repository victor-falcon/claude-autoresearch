/**
 * `.auto/log.jsonl` entry types, parsing and serialising (ported from
 * pi-autoresearch `jsonl.ts`, plus the writers that live in its `index.ts`
 * and `hooks.ts`). Entry shapes stay identical so a session can move between
 * pi and Claude Code.
 *
 * The log holds three kinds of lines:
 *   - config headers  `{"type":"config","name",...}` (one per segment)
 *   - run entries     `{"run":N,"commit",...}`
 *   - hook entries    `{"type":"hook","stage",...}` (observability only)
 */

import type { ExperimentAsi, ExperimentResult, ExperimentStatus, MetricDef, MetricDirection } from "../../types/index.d.ts";

export type JsonlEntry = Record<string, unknown>;

export interface AutoresearchConfigEntry extends JsonlEntry {
  type: "config";
  name?: string;
  metricName?: string;
  metricUnit?: string;
  bestDirection?: MetricDirection;
}

export interface AutoresearchRunEntry extends JsonlEntry {
  run: number;
}

export interface AutoresearchHookEntry extends JsonlEntry {
  type: "hook";
  stage: "before" | "after";
  exit_code: number | null;
  duration_ms: number;
  stdout_bytes: number;
  timed_out: boolean;
}

export type ReconstructedMetricDef = MetricDef;

export type ReconstructedRun = ExperimentResult;

export interface ReconstructedJsonlState {
  name: string | null;
  metricName: string;
  metricUnit: string;
  bestDirection: MetricDirection;
  currentSegment: number;
  results: ReconstructedRun[];
  secondaryMetrics: ReconstructedMetricDef[];
}

export const DEFAULT_METRIC_NAME = "metric";
export const DEFAULT_METRIC_UNIT = "";
export const DEFAULT_DIRECTION: MetricDirection = "lower";

function isObjectRecord(value: unknown): value is JsonlEntry {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter(Boolean);
}

/** Unit guessed from a secondary metric's name suffix. */
export function inferMetricUnit(name: string): string {
  if (name.endsWith("µs")) return "µs";
  if (name.endsWith("_ms")) return "ms";
  if (name.endsWith("_s") || name.endsWith("_sec")) return "s";
  if (name.endsWith("_kb")) return "kb";
  if (name.endsWith("_mb")) return "mb";
  return "";
}

function metricMapFrom(value: unknown): Record<string, number> {
  if (!isObjectRecord(value)) return {};

  const metrics: Record<string, number> = {};
  for (const [name, metric] of Object.entries(value)) {
    if (typeof metric === "number") metrics[name] = metric;
  }
  return metrics;
}

function statusFrom(value: unknown): ExperimentStatus {
  if (value === "discard") return "discard";
  if (value === "crash") return "crash";
  if (value === "checks_failed") return "checks_failed";
  return "keep";
}

function directionFrom(value: unknown): MetricDirection {
  return value === "higher" ? "higher" : DEFAULT_DIRECTION;
}

function asiFrom(value: unknown): ExperimentAsi | undefined {
  return isObjectRecord(value) ? value : undefined;
}

function reconstructedState(): ReconstructedJsonlState {
  return {
    name: null,
    metricName: DEFAULT_METRIC_NAME,
    metricUnit: DEFAULT_METRIC_UNIT,
    bestDirection: DEFAULT_DIRECTION,
    currentSegment: 0,
    results: [],
    secondaryMetrics: [],
  };
}

function updateConfig(state: ReconstructedJsonlState, entry: AutoresearchConfigEntry): void {
  if (typeof entry.name === "string") state.name = entry.name;
  if (typeof entry.metricName === "string") state.metricName = entry.metricName;
  if (typeof entry.metricUnit === "string") state.metricUnit = entry.metricUnit;
  state.bestDirection = directionFrom(entry.bestDirection);
}

function nextSegment(state: ReconstructedJsonlState, segment: number): number {
  if (state.results.length === 0) return segment;
  state.secondaryMetrics = [];
  return segment + 1;
}

function runFrom(entry: AutoresearchRunEntry, segment: number): ReconstructedRun {
  const run: ReconstructedRun = {
    run: typeof entry.run === "number" ? entry.run : 0,
    commit: typeof entry.commit === "string" ? entry.commit : "",
    metric: typeof entry.metric === "number" ? entry.metric : 0,
    metrics: metricMapFrom(entry.metrics),
    status: statusFrom(entry.status),
    description: typeof entry.description === "string" ? entry.description : "",
    timestamp: typeof entry.timestamp === "number" ? entry.timestamp : 0,
    segment,
    confidence: typeof entry.confidence === "number" ? entry.confidence : null,
  };
  const asi = asiFrom(entry.asi);
  if (asi) run.asi = asi;
  return run;
}

/** Add the metric names not seen yet, with their inferred unit. */
export function registerSecondaryMetrics(defs: MetricDef[], metrics: Record<string, number>): void {
  for (const name of Object.keys(metrics)) {
    if (defs.find((metric) => metric.name === name)) continue;
    defs.push({ name, unit: inferMetricUnit(name) });
  }
}

export function parseJsonlEntry(line: string): JsonlEntry | null {
  try {
    const parsed = JSON.parse(line);
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isAutoresearchConfigEntry(entry: unknown): entry is AutoresearchConfigEntry {
  return isObjectRecord(entry) && entry.type === "config";
}

export function isAutoresearchRunEntry(entry: unknown): entry is AutoresearchRunEntry {
  return isObjectRecord(entry) && typeof entry.run === "number";
}

export function isAutoresearchHookEntry(entry: unknown): entry is AutoresearchHookEntry {
  return isObjectRecord(entry) && entry.type === "hook";
}

function firstConfigEntry(jsonlContent: string): AutoresearchConfigEntry | null {
  for (const line of nonEmptyLines(jsonlContent)) {
    const entry = parseJsonlEntry(line);
    if (isAutoresearchConfigEntry(entry)) return entry;
  }
  return null;
}

export function hasAutoresearchConfigHeader(jsonlContent: string): boolean {
  return firstConfigEntry(jsonlContent) !== null;
}

export function extractAutoresearchSessionName(jsonlContent: string): string {
  return firstConfigEntry(jsonlContent)?.name || "Autoresearch";
}

/** The last run entry in the log, raw (as hooks receive it), or null. */
export function lastRunEntry(jsonlContent: string): AutoresearchRunEntry | null {
  const lines = nonEmptyLines(jsonlContent);
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseJsonlEntry(lines[i]!);
    if (isAutoresearchRunEntry(entry)) return entry;
  }
  return null;
}

export function reconstructJsonlState(jsonlContent: string): ReconstructedJsonlState {
  const state = reconstructedState();
  let segment = 0;

  for (const line of nonEmptyLines(jsonlContent)) {
    const entry = parseJsonlEntry(line);
    if (!entry) continue;

    if (isAutoresearchConfigEntry(entry)) {
      updateConfig(state, entry);
      segment = nextSegment(state, segment);
      state.currentSegment = segment;
      continue;
    }

    if (!isAutoresearchRunEntry(entry)) continue;

    const run = runFrom(entry, segment);
    state.results.push(run);
    registerSecondaryMetrics(state.secondaryMetrics, run.metrics);
  }

  return state;
}

// ---------------------------------------------------------------------------
// Writers: each returns one line, newline included, ready to append.
// ---------------------------------------------------------------------------

export interface ConfigHeaderFields {
  name: string | null;
  metricName: string;
  metricUnit: string;
  bestDirection: MetricDirection;
}

/** The config header `init_experiment` writes (key order as upstream). */
export function serializeConfigEntry(fields: ConfigHeaderFields): string {
  return JSON.stringify({
    type: "config",
    name: fields.name,
    metricName: fields.metricName,
    metricUnit: fields.metricUnit,
    bestDirection: fields.bestDirection,
  }) + "\n";
}

/**
 * The run entry `log_experiment` writes: `run` first, then the result's
 * fields in upstream order; `asi` only when present.
 */
export function serializeRunEntry(result: ExperimentResult): string {
  const entry: Record<string, unknown> = {
    run: result.run,
    commit: result.commit,
    metric: result.metric,
    metrics: result.metrics,
    status: result.status,
    description: result.description,
    timestamp: result.timestamp,
    segment: result.segment,
    confidence: result.confidence,
  };
  if (result.asi) entry.asi = result.asi;
  return JSON.stringify(entry) + "\n";
}

export interface HookRunOutcome {
  fired: boolean;
  stdout: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

/** The observability entry written after a before/after hook fired. */
export function hookLogEntry(stage: "before" | "after", result: HookRunOutcome): AutoresearchHookEntry {
  return {
    type: "hook",
    stage,
    exit_code: result.exitCode,
    duration_ms: result.durationMs,
    stdout_bytes: new TextEncoder().encode(result.stdout).length,
    timed_out: result.timedOut,
  };
}

export function serializeHookEntry(stage: "before" | "after", result: HookRunOutcome): string {
  return JSON.stringify(hookLogEntry(stage, result)) + "\n";
}

/**
 * The hook entry line to append to the log, or null when nothing should be
 * written: the hook did not fire, or the log has no config header yet (hook
 * observability must never create the log before `init_experiment`).
 */
export function hookLogLineIfConfigured(
  jsonlContent: string,
  stage: "before" | "after",
  result: HookRunOutcome,
): string | null {
  if (!result.fired) return null;
  if (!hasAutoresearchConfigHeader(jsonlContent)) return null;
  return serializeHookEntry(stage, result);
}
