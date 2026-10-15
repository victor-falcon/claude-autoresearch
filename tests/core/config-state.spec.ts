import assert from "node:assert/strict";
import test from "node:test";

import { maxExperimentsFrom, readConfig, resolveWorkDir, validateWorkDir } from "../../src/core/config.ts";
import {
  buildSessionSnapshot,
  experimentStateFromJsonl,
  isIterationLimitReached,
  loadSession,
  segmentRunCount,
} from "../../src/core/state.ts";
import { FakeIO } from "./fake-io.ts";

const LOG = [
  '{"type":"config","name":"Old","metricName":"ms","metricUnit":"ms","bestDirection":"lower"}',
  '{"run":1,"commit":"a","metric":500,"status":"keep","description":"old","timestamp":1,"metrics":{"x_ms":1}}',
  '{"type":"config","name":"Bundle","metricName":"bundle_kb","metricUnit":"kb","bestDirection":"lower"}',
  '{"run":2,"commit":"b","metric":100,"status":"keep","description":"baseline","timestamp":2,"metrics":{"gz_kb":30}}',
  '{"run":3,"commit":"c","metric":90,"status":"keep","description":"tree-shake","timestamp":3,"metrics":{"gz_kb":28}}',
  '{"run":4,"commit":"","metric":95,"status":"discard","description":"minify","timestamp":4,"metrics":{"gz_kb":29}}',
  '{"run":5,"commit":"e","metric":80,"status":"keep","description":"split","timestamp":5,"metrics":{"gz_kb":25}}',
].join("\n") + "\n";

test("readConfig answers {} when missing, invalid or not an object", async () => {
  assert.deepEqual(await readConfig(new FakeIO(), "/w"), {});
  assert.deepEqual(await readConfig(new FakeIO({ "/w/.auto/config.json": "{nope" }), "/w"), {});
  assert.deepEqual(await readConfig(new FakeIO({ "/w/.auto/config.json": "null" }), "/w"), {});
  assert.deepEqual(await readConfig(new FakeIO({ "/w/autoresearch.config.json": '{"maxIterations":3}' }), "/w"), {
    maxIterations: 3,
  });
});

test("maxIterations must be a positive number and is floored", () => {
  assert.equal(maxExperimentsFrom({}), null);
  assert.equal(maxExperimentsFrom({ maxIterations: 0 }), null);
  assert.equal(maxExperimentsFrom({ maxIterations: -2 }), null);
  assert.equal(maxExperimentsFrom({ maxIterations: "5" as unknown as number }), null);
  assert.equal(maxExperimentsFrom({ maxIterations: 7.9 }), 7);
});

test("workingDir resolves relative to cwd or is used as given", async () => {
  assert.equal(await resolveWorkDir(new FakeIO(), "/w"), "/w");
  assert.equal(await resolveWorkDir(new FakeIO({ "/w/.auto/config.json": '{"workingDir":"../bench"}' }), "/w"), "/bench");
  assert.equal(await resolveWorkDir(new FakeIO({ "/w/.auto/config.json": '{"workingDir":"."}' }), "/w"), "/w");
});

test("validateWorkDir reports a missing or non-directory workingDir", async () => {
  assert.equal(await validateWorkDir(new FakeIO(), "/w"), null);

  const missing = new FakeIO({ "/w/.auto/config.json": '{"workingDir":"sub"}' });
  assert.match((await validateWorkDir(missing, "/w")) ?? "", /"\/w\/sub" \(from \.auto\/config\.json\) does not exist/);

  const file = new FakeIO({ "/w/.auto/config.json": '{"workingDir":"sub"}', "/w/sub": "" });
  assert.match((await validateWorkDir(file, "/w")) ?? "", /is not a directory/);

  const dir = new FakeIO({ "/w/.auto/config.json": '{"workingDir":"sub"}' });
  dir.mkdir("/w/sub");
  assert.equal(await validateWorkDir(dir, "/w"), null);
});

test("experiment state derives baseline, best and confidence for the current segment", () => {
  const state = experimentStateFromJsonl(LOG, 10);

  assert.equal(state.name, "Bundle");
  assert.equal(state.metricUnit, "kb");
  assert.equal(state.currentSegment, 1);
  assert.equal(state.results.length, 5);
  assert.equal(state.baselineMetric, 100);
  assert.equal(state.bestKeptMetric, 80);
  // values 100, 90, 95, 80 → MAD 5; |80 - 100| / 5
  assert.equal(state.confidence, 4);
  assert.deepEqual(state.secondaryMetrics, [{ name: "gz_kb", unit: "kb" }]);
  assert.equal(state.maxExperiments, 10);
  assert.equal(segmentRunCount(state), 4);
  assert.equal(isIterationLimitReached(state), false);
  assert.equal(isIterationLimitReached({ ...state, maxExperiments: 4 }), true);
});

test("loadSession follows workingDir to the log and keeps config in cwd", async () => {
  const io = new FakeIO({
    "/w/.auto/config.json": '{"workingDir":"bench","maxIterations":2}',
    "/w/bench/.auto/log.jsonl": LOG,
  });

  const loaded = await loadSession(io, "/w");

  assert.deepEqual(loaded.paths, {
    cwd: "/w",
    workDir: "/w/bench",
    logPath: "/w/bench/.auto/log.jsonl",
    hasPersistedLog: true,
    logReadError: null,
  });
  assert.equal(loaded.state.results.length, 5);
  assert.equal(loaded.state.maxExperiments, 2);
});

test("loadSession without a log answers the empty state", async () => {
  const loaded = await loadSession(new FakeIO(), "/w");

  assert.equal(loaded.paths.hasPersistedLog, false);
  assert.equal(loaded.paths.logPath, "/w/.auto/log.jsonl");
  assert.equal(loaded.paths.logReadError, null);
  assert.equal(loaded.state.name, null);
  assert.deepEqual(loaded.state.results, []);
  assert.equal(loaded.state.baselineMetric, null);
});

test("loadSession reports an unreadable log instead of an empty session", async () => {
  const io = new FakeIO({ "/w/.auto/log.jsonl": LOG });
  io.readText = async () => {
    throw new Error("EFBIG: over 4 MiB");
  };

  const loaded = await loadSession(io, "/w");

  assert.equal(loaded.paths.hasPersistedLog, true);
  assert.equal(loaded.paths.logReadError, "EFBIG: over 4 MiB");
  assert.deepEqual(loaded.state.results, []);
});

test("an absolute workingDir is used verbatim, as upstream", async () => {
  const io = new FakeIO({ "/w/.auto/config.json": '{"workingDir":"/abs/x/"}' });
  assert.equal(await resolveWorkDir(io, "/w"), "/abs/x/");
});

test("the hook session snapshot uses upstream's snake_case shape", () => {
  assert.deepEqual(buildSessionSnapshot(experimentStateFromJsonl(LOG, null)), {
    metric_name: "bundle_kb",
    metric_unit: "kb",
    direction: "lower",
    baseline_metric: 100,
    best_metric: 80,
    run_count: 5,
    goal: "Bundle",
  });
});
