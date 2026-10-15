import assert from "node:assert/strict";
import test from "node:test";

import {
  extractAutoresearchSessionName,
  hasAutoresearchConfigHeader,
  hookLogLineIfConfigured,
  isAutoresearchConfigEntry,
  isAutoresearchHookEntry,
  isAutoresearchRunEntry,
  lastRunEntry,
  parseJsonlEntry,
  reconstructJsonlState,
  serializeConfigEntry,
  serializeRunEntry,
} from "../../src/core/jsonl.ts";

// Ported from pi-autoresearch tests/jsonl-helpers.test.mjs

test("hook entries are skipped when identifying run entries", () => {
  const hookEntry = parseJsonlEntry('{"type":"hook","stage":"before","exit_code":0}');
  const runEntry = parseJsonlEntry('{"run":1,"metric":42}');

  assert.equal(isAutoresearchConfigEntry(hookEntry), false);
  assert.equal(isAutoresearchRunEntry(hookEntry), false);
  assert.equal(isAutoresearchHookEntry(hookEntry), true);
  assert.equal(isAutoresearchRunEntry(runEntry), true);
});

test("hook-only jsonl does not count as having a config header", () => {
  const jsonl = '{"type":"hook","stage":"before","exit_code":0}\n';

  assert.equal(hasAutoresearchConfigHeader(jsonl), false);
});

test("session name comes from the first config entry, not the first line", () => {
  const jsonl = [
    '{"type":"hook","stage":"before","exit_code":0}',
    '{"type":"config","name":"Hook-safe session","metricName":"total_ms","metricUnit":"ms","bestDirection":"lower"}',
    '{"run":1,"commit":"abc1234","metric":10,"status":"keep","description":"baseline","timestamp":1,"metrics":{}}',
  ].join("\n");

  assert.equal(hasAutoresearchConfigHeader(jsonl), true);
  assert.equal(extractAutoresearchSessionName(jsonl), "Hook-safe session");
});

test("reconstructJsonlState ignores hooks and preserves run segments", () => {
  const jsonl = [
    '{"type":"config","name":"Segmented session","metricName":"total_ms","metricUnit":"ms","bestDirection":"lower"}',
    '{"type":"hook","stage":"before","exit_code":0}',
    '{"run":1,"commit":"aaa1111","metric":10,"status":"keep","description":"baseline","timestamp":1,"metrics":{"compile_ms":4}}',
    '{"type":"hook","stage":"after","exit_code":0}',
    '{"type":"config","name":"Segmented session","metricName":"total_ms","metricUnit":"ms","bestDirection":"lower"}',
    '{"type":"hook","stage":"before","exit_code":0}',
    '{"run":2,"commit":"bbb2222","metric":7,"status":"keep","description":"new baseline","timestamp":2,"metrics":{"render_ms":2}}',
  ].join("\n");

  const state = reconstructJsonlState(jsonl);

  assert.equal(state.results.length, 2);
  assert.deepEqual(state.results.map((result) => result.metric), [10, 7]);
  assert.deepEqual(state.results.map((result) => result.segment), [0, 1]);
  assert.equal(state.currentSegment, 1);
  assert.deepEqual(state.secondaryMetrics.map((metric) => metric.name), ["render_ms"]);
});

test("hook observability does not write before a config header exists", () => {
  const result = { fired: true, stdout: "", exitCode: 0, timedOut: false, durationMs: 5 };

  assert.equal(hookLogLineIfConfigured("", "before", result), null);
  assert.equal(
    hookLogLineIfConfigured('{"type":"hook","stage":"before","exit_code":0}\n', "after", result),
    null,
  );
});

// Added for the port

test("hook entry line is written once the log has a config header", () => {
  const log = serializeConfigEntry({ name: "S", metricName: "ms", metricUnit: "ms", bestDirection: "lower" });
  const line = hookLogLineIfConfigured(log, "after", {
    fired: true,
    stdout: "µs\n",
    exitCode: 1,
    timedOut: false,
    durationMs: 12,
  });

  assert.equal(
    line,
    '{"type":"hook","stage":"after","exit_code":1,"duration_ms":12,"stdout_bytes":4,"timed_out":false}\n',
  );
  assert.equal(
    hookLogLineIfConfigured(log, "after", { fired: false, stdout: "", exitCode: null, timedOut: false, durationMs: 0 }),
    null,
  );
});

test("config and run entries serialise exactly as pi-autoresearch writes them", () => {
  assert.equal(
    serializeConfigEntry({ name: "Speed", metricName: "total_µs", metricUnit: "µs", bestDirection: "higher" }),
    '{"type":"config","name":"Speed","metricName":"total_µs","metricUnit":"µs","bestDirection":"higher"}\n',
  );

  const base = {
    run: 3,
    commit: "abc1234",
    metric: 12.5,
    metrics: { compile_ms: 4 },
    status: "keep" as const,
    description: "cache",
    timestamp: 1700000000000,
    segment: 1,
    confidence: 2.5,
  };
  assert.equal(
    serializeRunEntry(base),
    '{"run":3,"commit":"abc1234","metric":12.5,"metrics":{"compile_ms":4},"status":"keep","description":"cache","timestamp":1700000000000,"segment":1,"confidence":2.5}\n',
  );
  assert.match(serializeRunEntry({ ...base, asi: { hypothesis: "h" } }), /"confidence":2.5,"asi":\{"hypothesis":"h"\}\}\n$/);
});

test("serialised entries round-trip through reconstruction", () => {
  const log =
    serializeConfigEntry({ name: "S", metricName: "ms", metricUnit: "ms", bestDirection: "higher" }) +
    serializeRunEntry({
      run: 1,
      commit: "a",
      metric: 5,
      metrics: { size_kb: 9 },
      status: "checks_failed",
      description: "d",
      timestamp: 1,
      segment: 0,
      confidence: null,
      asi: { rollback_reason: "r" },
    });

  const state = reconstructJsonlState(log);
  assert.equal(state.bestDirection, "higher");
  assert.deepEqual(state.results[0], {
    run: 1,
    commit: "a",
    metric: 5,
    metrics: { size_kb: 9 },
    status: "checks_failed",
    description: "d",
    timestamp: 1,
    segment: 0,
    confidence: null,
    asi: { rollback_reason: "r" },
  });
  assert.deepEqual(state.secondaryMetrics, [{ name: "size_kb", unit: "kb" }]);
});

test("malformed lines are ignored and missing fields get defaults", () => {
  const state = reconstructJsonlState('not json\n[1,2]\n{"run":1}\n');

  assert.equal(state.name, null);
  assert.equal(state.metricName, "metric");
  assert.equal(state.bestDirection, "lower");
  assert.deepEqual(state.results, [
    { run: 1, commit: "", metric: 0, metrics: {}, status: "keep", description: "", timestamp: 0, segment: 0, confidence: null },
  ]);
});

test("lastRunEntry returns the last run line, skipping hooks", () => {
  const jsonl = [
    '{"type":"config","name":"S"}',
    '{"run":1,"metric":10}',
    '{"run":2,"metric":9}',
    '{"type":"hook","stage":"after","exit_code":0}',
  ].join("\n");

  assert.deepEqual(lastRunEntry(jsonl), { run: 2, metric: 9 });
  assert.equal(lastRunEntry('{"type":"config"}\n'), null);
});
