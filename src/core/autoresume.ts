/**
 * Auto-resume guards and resume prompts (ported from
 * pi-autoresearch `index.ts`).
 */

import type { ExperimentState } from "../../types/index.d.ts";

export const AUTORESUME_TURN_LIMIT = 200;
export const CONSECUTIVE_FAILURE_OVERRIDE_LIMIT = 20;

export const BENCHMARK_GUARDRAIL =
  "Be careful not to overfit to the benchmarks and do not cheat on the benchmarks.";

export type AutoResumeGuardState = Pick<ExperimentState, "results" | "currentSegment">;
export type AutoResumeGuardRuntime = {
  autoResumeTurns: number;
  state: AutoResumeGuardState;
};

/** Count trailing discard/crash results in the current segment. */
export function countConsecutiveDiscardOrCrashResults(state: AutoResumeGuardState): number {
  let count = 0;
  for (let i = state.results.length - 1; i >= 0; i--) {
    const result = state.results[i]!;
    if (result.segment !== state.currentSegment) break;
    if (result.status === "discard" || result.status === "crash") {
      count++;
      continue;
    }
    break;
  }
  return count;
}

/** Why auto-resume must stop now, or null to keep going. */
export function autoResumeStopReasonFor(runtime: AutoResumeGuardRuntime): string | null {
  if (runtime.autoResumeTurns >= AUTORESUME_TURN_LIMIT) {
    return `Autoresearch auto-resume limit reached (${AUTORESUME_TURN_LIMIT} turns)`;
  }
  const failures = countConsecutiveDiscardOrCrashResults(runtime.state);
  if (failures > CONSECUTIVE_FAILURE_OVERRIDE_LIMIT) {
    return `Autoresearch auto-resume stopped — ${failures} consecutive discards/crashes`;
  }
  return null;
}

/**
 * Whether a finished turn should be followed by a resume prompt. A chat-only
 * session (no experiment logged yet) never auto-resumes, or every turn end
 * would re-prompt a chat forever.
 */
export function shouldAutoResumeAfterTurn(modeEnabled: boolean, experimentsThisSession: number): boolean {
  return modeEnabled && experimentsThisSession > 0;
}

/** The prompt sent to continue the loop after a turn ends. */
export function composeResumeMessage(): string {
  return [
    "Run the next iteration now.",
    "Use the persisted autoresearch state as needed, pick the most promising hypothesis, then call run_experiment + log_experiment.",
    BENCHMARK_GUARDRAIL,
  ].join(" ");
}

/** The prompt sent to continue the loop after a compaction. */
export function composeCompactionResumeMessage(): string {
  return [
    "Run the next iteration now.",
    "Pick the most promising hypothesis from the ideas backlog or the latest `next:` hints in recent runs, then call run_experiment + log_experiment.",
    "Do not re-read .auto/prompt.md or .auto/log.jsonl — the compaction summary already contains them.",
    BENCHMARK_GUARDRAIL,
  ].join(" ");
}
