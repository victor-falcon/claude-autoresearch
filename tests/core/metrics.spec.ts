import assert from "node:assert/strict";
import test from "node:test";

import type { ExperimentResult, ExperimentStatus } from "../../types/index.d.ts";
import {
  commas,
  computeConfidence,
  describeConfidence,
  findBaselineMetric,
  findBaselineRunNumber,
  findBaselineSecondary,
  findBestMetric,
  fmtNum,
  formatElapsed,
  formatNum,
  isAutoresearchShCommand,
  isBetter,
  parseMetricLines,
  sortedMedian,
} from "../../src/core/metrics.ts";

function run(metric: number, status: ExperimentStatus = "keep", segment = 0, metrics: Record<string, number> = {}): ExperimentResult {
  return { run: 0, commit: "", metric, metrics, status, description: "", timestamp: 0, segment, confidence: null };
}

test("parseMetricLines reads METRIC lines, last value wins, rejects junk", () => {
  const output = [
    "building...",
    "METRIC total_µs=15200",
    "METRIC compile_µs=4200",
    "METRIC total_µs=15100",
    "METRIC bad=Infinity",
    "METRIC nan=NaN",
    "METRIC __proto__=1",
    "METRIC val.bpb=0.98  ",
    "  METRIC indented=1",
    "METRIC with space=1",
  ].join("\n");

  assert.deepEqual([...parseMetricLines(output)], [
    ["total_µs", 15100],
    ["compile_µs", 4200],
    ["val.bpb", 0.98],
  ]);
});

test("number formatting matches upstream", () => {
  assert.equal(commas(15586), "15,586");
  assert.equal(commas(999), "999");
  assert.equal(fmtNum(1234.5, 1), "1,234.5");
  assert.equal(fmtNum(-1234.25, 2), "-1,234.25");
  assert.equal(formatNum(null, "ms"), "—");
  assert.equal(formatNum(15200, "µs"), "15,200µs");
  assert.equal(formatNum(0.98123, ""), "0.98");
  assert.equal(formatElapsed(5_900), "5s");
  assert.equal(formatElapsed(65_000), "1m 05s");
});

test("isBetter follows the direction", () => {
  assert.equal(isBetter(1, 2, "lower"), true);
  assert.equal(isBetter(1, 2, "higher"), false);
  assert.equal(isBetter(2, 2, "lower"), false);
});

test("sortedMedian handles empty, odd and even inputs", () => {
  assert.equal(sortedMedian([]), 0);
  assert.equal(sortedMedian([3, 1, 2]), 2);
  assert.equal(sortedMedian([4, 1, 3, 2]), 2.5);
});

test("baseline and best are per segment; best only counts kept runs", () => {
  const results = [run(500, "keep", 0), run(100, "keep", 1), run(50, "discard", 1), run(80, "keep", 1), run(90, "keep", 1)];

  assert.equal(findBaselineMetric(results, 1), 100);
  assert.equal(findBestMetric(results, 1, "lower"), 80);
  assert.equal(findBestMetric(results, 1, "higher"), 100);
  assert.equal(findBaselineRunNumber(results, 1), 2);
  assert.equal(findBaselineMetric(results, 7), null);
  assert.equal(findBestMetric(results, 7, "lower"), null);
  assert.equal(findBaselineRunNumber(results, 7), null);
});

test("secondary baselines fall back to each metric's first occurrence", () => {
  const results = [run(10, "keep", 0, { a_ms: 1 }), run(9, "keep", 0, { a_ms: 2, b_kb: 7 }), run(8, "keep", 0, { b_kb: 6 })];

  assert.deepEqual(findBaselineSecondary(results, 0), { a_ms: 1 });
  assert.deepEqual(
    findBaselineSecondary(results, 0, [{ name: "a_ms", unit: "ms" }, { name: "b_kb", unit: "kb" }]),
    { a_ms: 1, b_kb: 7 },
  );
});

test("confidence is |best - baseline| / MAD over the segment", () => {
  // values 100, 90, 95, 80 → median 92.5, deviations 7.5, 2.5, 2.5, 12.5 → MAD 5
  const results = [run(100), run(90), run(95, "discard"), run(80)];
  assert.equal(computeConfidence(results, 0, "lower"), 20 / 5);
});

test("confidence is null with too little data, zero noise, or no improvement", () => {
  assert.equal(computeConfidence([run(100), run(90)], 0, "lower"), null);
  assert.equal(computeConfidence([run(100), run(100), run(100)], 0, "lower"), null);
  assert.equal(computeConfidence([run(100), run(120, "discard"), run(130, "discard")], 0, "lower"), null);
  // crashes (metric 0) are left out of the data points
  assert.equal(computeConfidence([run(100), run(0, "crash"), run(90)], 0, "lower"), null);
});

test("confidence ignores other segments", () => {
  const results = [run(1, "keep", 0), run(500, "keep", 0), run(100, "keep", 1), run(90, "keep", 1), run(95, "keep", 1)];
  assert.equal(computeConfidence(results, 1, "lower"), 10 / 5);
});

test("confidence wording follows upstream thresholds", () => {
  assert.match(describeConfidence(2.0), /2\.0× noise floor — improvement is likely real/);
  assert.match(describeConfidence(1.2), /above noise but marginal/);
  assert.match(describeConfidence(0.4), /^⚠️ .*within noise/);
});

test("benchmark command detection accepts wrappers and rejects chaining", () => {
  for (const ok of [
    ".auto/measure.sh",
    "./.auto/measure.sh --quick",
    "bash .auto/measure.sh",
    "bash -x ./autoresearch.sh",
    "FOO=1 BAR=x nice -n 10 time .auto/measure.sh",
    "/abs/path/.auto/measure.sh",
  ]) {
    assert.equal(isAutoresearchShCommand(ok), true, ok);
  }
  for (const bad of ["evil.py; .auto/measure.sh", "pnpm test", "cat .auto/measure.sh.bak", "python measure.sh"]) {
    assert.equal(isAutoresearchShCommand(bad), false, bad);
  }
});
