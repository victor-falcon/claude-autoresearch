// The autoresearch plugin contract: every value the mod keeps in `$.state`,
// and the experiment types shared by `src/core` (pure) and the feature modules.
//
// Derived from pi-autoresearch's `ExperimentState` / `AutoresearchRuntime`.
// The on-disk shapes (`.auto/log.jsonl` entries) live in `src/core/jsonl.ts`
// and stay byte-compatible with pi-autoresearch.
//
// `$.state.set` refuses `undefined`, so "absent" is always spelled `null`.

/** Whether a lower or a higher primary metric is better. */
export type MetricDirection = 'lower' | 'higher'

/** Outcome of one experiment, as logged by `log_experiment`. */
export type ExperimentStatus = 'keep' | 'discard' | 'crash' | 'checks_failed'

/**
 * Actionable Side Information: free-form diagnostics per run, chosen by the
 * agent (`hypothesis`, `next_action_hint`, `rollback_reason`, ...).
 */
export type ExperimentAsi = { [key: string]: unknown }

/** A primary or secondary metric definition. */
export type MetricDef = {
  name: string
  unit: string
}

/** One logged experiment. */
export type ExperimentResult = {
  /** Run number as written to the log (1-based, across all segments). */
  run: number
  /** Short git commit hash ("" when nothing was committed). */
  commit: string
  /** Primary metric value (0 for crashes). */
  metric: number
  /** Secondary metrics: `{ name: value }`. */
  metrics: Record<string, number>
  status: ExperimentStatus
  description: string
  /** Milliseconds since the epoch. */
  timestamp: number
  /** Segment index: increments on each config header (re-init). */
  segment: number
  /** Session confidence when this run was logged; null with too little data. */
  confidence: number | null
  asi?: ExperimentAsi
}

/** The experiment session, reconstructed from `.auto/log.jsonl`. */
export type ExperimentState = {
  /** Human-readable session name (`init_experiment`'s `name`). */
  name: string | null
  metricName: string
  metricUnit: string
  bestDirection: MetricDirection
  /** Current segment: the highest one; earlier segments are history. */
  currentSegment: number
  /** Every logged run, all segments, in log order. */
  results: ExperimentResult[]
  /** Secondary metric definitions for the current segment, in first-seen order. */
  secondaryMetrics: MetricDef[]
  /** Baseline primary metric: the first run of the current segment. */
  baselineMetric: number | null
  /** Best kept primary metric of the current segment. */
  bestKeptMetric: number | null
  /** Best improvement over baseline as a multiple of the noise floor (MAD). */
  confidence: number | null
  /** `maxIterations` from `.auto/config.json`; null = unlimited. */
  maxExperiments: number | null
}

/**
 * Where the session files are, as resolved when the experiment state was last
 * reloaded (session start, or `reloadExperiment`). A snapshot: re-resolve
 * after editing `.auto/config.json`.
 */
export type SessionPaths = {
  /** The session's cwd, where `.auto/config.json` is read. */
  cwd: string
  /** The effective work dir (`workingDir` from config, else `cwd`). */
  workDir: string
  /** The log in effect (`.auto/log.jsonl`, or legacy `autoresearch.jsonl`). */
  logPath: string
  /** Whether that log existed at the reload. */
  hasPersistedLog: boolean
  /** Why an existing log could not be read (e.g. over 4 MiB); null when read. */
  logReadError: string | null
}

/**
 * Explicit `/autoresearch on|off` decisions recorded this session, by
 * canonical work dir. A recorded decision wins over auto-activation.
 */
export type ModeDecisions = Record<string, boolean>

/** The experiment `run_experiment` is running right now. */
export type RunningExperiment = {
  /** Milliseconds since the epoch. */
  startedAt: number
  command: string
}

/** Checks outcome of the last `run_experiment`, consumed by `log_experiment`. */
export type LastRunChecks = {
  pass: boolean
  output: string
  /** Seconds. */
  duration: number
}

/** What `run_experiment` leaves for the next `log_experiment`. */
export type LastRunState = {
  checks: LastRunChecks | null
  /** Wall-clock seconds of the last benchmark run. */
  durationSeconds: number | null
}

/** A resume prompt waiting for the agent to settle. */
export type PendingResume = {
  message: string
  /** Milliseconds since the epoch when it may be sent. */
  dueAt: number
}

/** Auto-resume bookkeeping for the continuous loop. */
export type AutoResumeState = {
  /** Resume prompts sent this session (capped by AUTORESUME_TURN_LIMIT). */
  turns: number
  /** Experiments logged this session; a chat-only turn never auto-resumes. */
  experimentsThisSession: number
  pendingResume: PendingResume | null
}

declare module 'claude-code' {
  interface PluginState {
    'autoresearch': {
      /** Autoresearch mode: gates the tools, the loop and the UI. */
      enabled: boolean
      decisions: ModeDecisions
      /** null until the first reload. */
      paths: SessionPaths | null
      experiment: ExperimentState
      running: RunningExperiment | null
      lastRun: LastRunState
      autoResume: AutoResumeState
    }
  }
}
