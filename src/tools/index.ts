import type { On } from 'claude-code'

/**
 * The model-facing tools: init_experiment, run_experiment, log_experiment
 * (schemas in src/core/schemas.ts). They are offered only while `enabled`
 * (src/runtime/state.ts) is true.
 *
 * No-op stub wired into hooks/register.tsx; implemented in T2.
 */
export function registerTools(_on: On): void {}
