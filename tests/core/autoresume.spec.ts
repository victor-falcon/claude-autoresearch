import assert from "node:assert/strict";
import test from "node:test";

import type { ExperimentResult, ExperimentStatus } from "../../types/index.d.ts";
import {
  AUTORESUME_TURN_LIMIT,
  BENCHMARK_GUARDRAIL,
  CONSECUTIVE_FAILURE_OVERRIDE_LIMIT,
  autoResumeStopReasonFor,
  composeCompactionResumeMessage,
  composeResumeMessage,
  countConsecutiveDiscardOrCrashResults,
  shouldAutoActivateAutoresearch,
  shouldAutoResumeAfterTurn,
} from "../../src/core/autoresume.ts";

// Ported from pi-autoresearch tests/auto-resume-guards.test.mjs

function result(status: ExperimentStatus, segment = 0): ExperimentResult {
  return {
    run: 0,
    commit: status === "keep" ? "abcdef0" : "",
    metric: status === "crash" ? 0 : 10,
    metrics: {},
    status,
    description: status,
    timestamp: 0,
    segment,
    confidence: null,
  };
}

function state(results: ExperimentResult[], currentSegment = 0) {
  return { results, currentSegment };
}

function runtime(autoResumeTurns: number, results: ExperimentResult[], currentSegment = 0) {
  return { autoResumeTurns, state: state(results, currentSegment) };
}

test("auto-resume turn ceiling is 200", () => {
  assert.equal(AUTORESUME_TURN_LIMIT, 200);
  assert.equal(autoResumeStopReasonFor(runtime(199, [])), null);
  assert.match(autoResumeStopReasonFor(runtime(200, [])) ?? "", /200 turns/);
});

test("consecutive discard/crash override stops after more than 20 failures", () => {
  const failuresAtLimit = Array.from(
    { length: CONSECUTIVE_FAILURE_OVERRIDE_LIMIT },
    (_, index) => result(index % 2 === 0 ? "discard" : "crash"),
  );
  assert.equal(countConsecutiveDiscardOrCrashResults(state(failuresAtLimit)), 20);
  assert.equal(autoResumeStopReasonFor(runtime(0, failuresAtLimit)), null);

  const failuresPastLimit = [...failuresAtLimit, result("discard")];
  assert.equal(countConsecutiveDiscardOrCrashResults(state(failuresPastLimit)), 21);
  assert.match(
    autoResumeStopReasonFor(runtime(0, failuresPastLimit)) ?? "",
    /21 consecutive discards\/crashes/,
  );
});

test("consecutive failure override resets on keep and ignores previous segments", () => {
  const failuresPastLimit = Array.from({ length: CONSECUTIVE_FAILURE_OVERRIDE_LIMIT + 1 }, () => result("discard"));

  assert.equal(countConsecutiveDiscardOrCrashResults(state([...failuresPastLimit, result("keep")])), 0);
  assert.equal(autoResumeStopReasonFor(runtime(0, [...failuresPastLimit, result("keep")])), null);

  const previousSegmentFailures = failuresPastLimit.map((entry) => ({ ...entry, segment: 0 }));
  const currentSegmentFailure = result("crash", 1);
  assert.equal(
    countConsecutiveDiscardOrCrashResults(state([...previousSegmentFailures, currentSegmentFailure], 1)),
    1,
  );
  assert.equal(autoResumeStopReasonFor(runtime(0, [...previousSegmentFailures, currentSegmentFailure], 1)), null);
});

// Added for the port

test("checks_failed breaks a run of discards and crashes", () => {
  const results = [result("discard"), result("checks_failed"), result("crash"), result("discard")];
  assert.equal(countConsecutiveDiscardOrCrashResults(state(results)), 2);
});

test("a chat-only session never auto-resumes", () => {
  assert.equal(shouldAutoResumeAfterTurn(true, 0), false);
  assert.equal(shouldAutoResumeAfterTurn(false, 3), false);
  assert.equal(shouldAutoResumeAfterTurn(true, 1), true);
});

test("resume messages carry the benchmark guardrail", () => {
  assert.match(composeResumeMessage(), /^Run the next iteration now\./);
  assert.ok(composeResumeMessage().endsWith(BENCHMARK_GUARDRAIL));
  assert.match(composeCompactionResumeMessage(), /Do not re-read \.auto\/prompt\.md or \.auto\/log\.jsonl/);
  assert.ok(composeCompactionResumeMessage().endsWith(BENCHMARK_GUARDRAIL));
});

test("auto-activation needs a log; a recorded decision wins; redirected dirs default off", () => {
  assert.equal(shouldAutoActivateAutoresearch(true, false, true), false);
  assert.equal(shouldAutoActivateAutoresearch(true, true), true);
  assert.equal(shouldAutoActivateAutoresearch(false, true), false);
  assert.equal(shouldAutoActivateAutoresearch(true, true, false), false);
  assert.equal(shouldAutoActivateAutoresearch(false, true, true), true);
});
