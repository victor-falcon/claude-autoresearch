/**
 * Metric parsing, formatting and per-segment statistics (ported from the pure
 * helpers in pi-autoresearch `index.ts`).
 */

import type { ExperimentResult, MetricDef, MetricDirection } from "../../types/index.d.ts";

// ---------------------------------------------------------------------------
// METRIC lines
// ---------------------------------------------------------------------------

/** Prefix for structured metric output lines: `METRIC name=value` */
export const METRIC_LINE_PREFIX = "METRIC";

/** Metric names that could cause prototype pollution if used as object keys */
const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Parse structured METRIC lines from command output.
 * Format: `METRIC name=value` (one per line), e.g. `METRIC total_µs=15200`.
 *
 * Names must be word chars, dots, or µ. Values must be finite numbers.
 * Duplicate names: last occurrence wins. The Map keeps first-occurrence order.
 */
export function parseMetricLines(output: string): Map<string, number> {
  const metrics = new Map<string, number>();
  const regex = new RegExp(`^${METRIC_LINE_PREFIX}\\s+([\\w.µ]+)=(\\S+)\\s*$`, "gm");
  let match;
  while ((match = regex.exec(output)) !== null) {
    const name = match[1]!;
    if (DENIED_METRIC_NAMES.has(name)) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) {
      metrics.set(name, value);
    }
  }
  return metrics;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Format a number with comma-separated thousands: 15586 → "15,586" */
export function commas(n: number): string {
  const s = String(Math.round(n));
  const parts: string[] = [];
  for (let i = s.length; i > 0; i -= 3) {
    parts.unshift(s.slice(Math.max(0, i - 3), i));
  }
  return parts.join(",");
}

/** Format number with commas, keeping `decimals` fractional digits */
export function fmtNum(n: number, decimals: number = 0): string {
  if (decimals > 0) {
    const int = Math.floor(Math.abs(n));
    const frac = (Math.abs(n) - int).toFixed(decimals).slice(1); // ".3"
    return (n < 0 ? "-" : "") + commas(int) + frac;
  }
  return commas(n);
}

/** Integers without decimals, fractions with two; `—` for null. */
export function formatNum(value: number | null, unit: string): string {
  if (value === null) return "—";
  const u = unit || "";
  if (value === Math.round(value)) return fmtNum(value) + u;
  return fmtNum(value, 2) + u;
}

/** Format elapsed milliseconds as "Xm XXs" or "XXs" */
export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export function isBetter(current: number, best: number, direction: MetricDirection): boolean {
  return direction === "lower" ? current < best : current > best;
}

/** Results in one segment only */
export function currentResults(results: ExperimentResult[], segment: number): ExperimentResult[] {
  return results.filter((r) => r.segment === segment);
}

/** Median of a numeric array (0 for an empty one) */
export function sortedMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

/** Baseline = first experiment in the segment */
export function findBaselineMetric(results: ExperimentResult[], segment: number): number | null {
  const cur = currentResults(results, segment);
  return cur.length > 0 ? cur[0]!.metric : null;
}

/** Best = optimal metric across kept experiments in the segment */
export function findBestMetric(
  results: ExperimentResult[],
  segment: number,
  direction: MetricDirection,
): number | null {
  const kept = currentResults(results, segment)
    .filter((r) => r.status === "keep")
    .map((r) => r.metric);
  if (kept.length === 0) return null;
  return direction === "lower" ? Math.min(...kept) : Math.max(...kept);
}

/** 1-based position (in all results) of the segment's baseline run */
export function findBaselineRunNumber(results: ExperimentResult[], segment: number): number | null {
  const index = results.findIndex((result) => result.segment === segment);
  return index >= 0 ? index + 1 : null;
}

/**
 * Secondary metric baselines from the first experiment in the segment. For
 * metrics that didn't exist at baseline time, falls back to their first
 * occurrence in the segment.
 */
export function findBaselineSecondary(
  results: ExperimentResult[],
  segment: number,
  knownMetrics?: MetricDef[],
): Record<string, number> {
  const cur = currentResults(results, segment);
  const base: Record<string, number> = cur.length > 0 ? { ...(cur[0]!.metrics ?? {}) } : {};

  if (knownMetrics) {
    for (const sm of knownMetrics) {
      if (base[sm.name] !== undefined) continue;
      for (const r of cur) {
        const val = (r.metrics ?? {})[sm.name];
        if (val !== undefined) {
          base[sm.name] = val;
          break;
        }
      }
    }
  }

  return base;
}

/**
 * Confidence of the best improvement vs. the session noise floor.
 *
 * Uses the Median Absolute Deviation (MAD) of all metric values in the segment
 * as a robust noise estimator and returns `|best_delta| / MAD`, best_delta
 * being the best kept metric's improvement over baseline.
 *
 * null with fewer than 3 data points, when MAD is 0, or with no improvement.
 */
export function computeConfidence(
  results: ExperimentResult[],
  segment: number,
  direction: MetricDirection,
): number | null {
  const cur = currentResults(results, segment).filter((r) => r.metric > 0);
  if (cur.length < 3) return null;

  const values = cur.map((r) => r.metric);
  const median = sortedMedian(values);
  const deviations = values.map((v) => Math.abs(v - median));
  const mad = sortedMedian(deviations);

  if (mad === 0) return null;

  const baseline = findBaselineMetric(results, segment);
  if (baseline === null) return null;

  let bestKept: number | null = null;
  for (const r of cur) {
    if (r.status === "keep" && r.metric > 0) {
      if (bestKept === null || isBetter(r.metric, bestKept, direction)) {
        bestKept = r.metric;
      }
    }
  }
  if (bestKept === null || bestKept === baseline) return null;

  return Math.abs(bestKept - baseline) / mad;
}

/** The sentence `log_experiment` shows for a confidence score. */
export function describeConfidence(confidence: number): string {
  const confStr = confidence.toFixed(1);
  if (confidence >= 2.0) {
    return `📊 Confidence: ${confStr}× noise floor — improvement is likely real`;
  }
  if (confidence >= 1.0) {
    return `📊 Confidence: ${confStr}× noise floor — improvement is above noise but marginal`;
  }
  return `⚠️ Confidence: ${confStr}× noise floor — improvement is within noise. Consider re-running to confirm before keeping.`;
}

// ---------------------------------------------------------------------------
// Benchmark command detection
// ---------------------------------------------------------------------------

/**
 * Whether a command's primary purpose is running the benchmark script.
 *
 * Strips harmless prefixes (env vars, env/time/nice/nohup wrappers), then
 * requires the benchmark script to be the first real command, rejecting
 * chaining tricks like "evil.py; .auto/measure.sh".
 */
export function isAutoresearchShCommand(command: string): boolean {
  let cmd = command.trim();

  cmd = cmd.replace(/^(?:\w+=\S*\s+)+/, "");

  let prev: string;
  do {
    prev = cmd;
    cmd = cmd.replace(/^(?:env|time|nice|nohup)(?:\s+-\S+(?:\s+\d+)?)*\s+/, "");
  } while (cmd !== prev);

  return /^(?:(?:bash|sh|source)\s+(?:-\w+\s+)*)?(?:\/|\.{1,2}\/|[\w.-]+\/)*(?:autoresearch\.sh|\.auto\/measure\.sh)(?:\s|$)/.test(cmd);
}
