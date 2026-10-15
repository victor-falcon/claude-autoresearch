/**
 * JSON Schemas for the three tools' inputs (ported from pi-autoresearch's
 * TypeBox schemas), ready for `$.tool.register({ inputSchema })`.
 *
 * Dynamic objects use `additionalProperties`, never `patternProperties`, which
 * some model providers reject.
 */

export const INIT_EXPERIMENT_SCHEMA = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description:
        'Human-readable name for this experiment session (e.g. "Optimizing liquid for fastest execution and parsing")',
    },
    metric_name: {
      type: "string",
      description:
        'Display name for the primary metric (e.g. "total_µs", "bundle_kb", "val_bpb"). Shown in dashboard headers.',
    },
    metric_unit: {
      type: "string",
      description:
        'Unit for the primary metric. Use "µs", "ms", "s", "kb", "mb", or "" for unitless. Affects number formatting. Default: ""',
    },
    direction: {
      type: "string",
      description: 'Whether "lower" or "higher" is better for the primary metric. Default: "lower".',
    },
  },
  required: ["name", "metric_name"],
} as const;

export const RUN_EXPERIMENT_SCHEMA = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description: "Shell command to run (e.g. 'pnpm test:vitest', 'uv run train.py')",
    },
    timeout_seconds: {
      type: "number",
      description: "Kill after this many seconds (default: 600)",
    },
    checks_timeout_seconds: {
      type: "number",
      description:
        "Kill .auto/checks.sh after this many seconds (default: 300). Only relevant when the checks file exists.",
    },
  },
  required: ["command"],
} as const;

export const LOG_EXPERIMENT_SCHEMA = {
  type: "object",
  properties: {
    commit: { type: "string", description: "Git commit hash (short, 7 chars)" },
    metric: {
      type: "number",
      description: "The primary optimization metric value (e.g. seconds, val_bpb). 0 for crashes.",
    },
    status: { type: "string", enum: ["keep", "discard", "crash", "checks_failed"] },
    description: { type: "string", description: "Short description of what this experiment tried" },
    metrics: {
      type: "object",
      properties: {},
      additionalProperties: { type: "number" },
      description:
        'Additional metrics to track as { name: value } pairs, e.g. { "compile_µs": 4200, "render_µs": 9800 }. These are shown alongside the primary metric for tradeoff monitoring.',
    },
    force: {
      type: "boolean",
      description:
        "Set to true to allow adding a new secondary metric that wasn't tracked before. Only use for metrics that have proven very valuable to watch.",
    },
    asi: {
      type: "object",
      properties: {},
      additionalProperties: {},
      description:
        "Actionable Side Information — structured diagnostics for this run. Free-form key/value pairs. Parsed ASI from run_experiment output is merged automatically; use this to add or override fields.",
    },
  },
  required: ["commit", "metric", "status", "description"],
} as const;
