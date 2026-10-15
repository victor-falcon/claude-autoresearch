// The system-prompt section while the mode is on (upstream
// `before_agent_start`): a short pointer to the session files, no file
// content, so the prompt stays cache-friendly.

import type { EngineInterface } from 'claude-code'

import { BENCHMARK_GUARDRAIL } from '../core/autoresume.ts'
import { sessionFile } from '../runtime/index.ts'

export const PROMPT_SECTION_ID = 'autoresearch:mode'

export type SectionFiles = {
  promptPath: string
  ideasPath: string | null
  checksPath: string | null
}

export function composeModeSection(files: SectionFiles): string {
  let text =
    '## Autoresearch Mode (ACTIVE)' +
    '\nYou are in autoresearch mode. Optimize the primary metric through an autonomous experiment loop.' +
    '\nUse the init_experiment, run_experiment, and log_experiment tools (mcp__autoresearch__*). NEVER STOP until interrupted.' +
    `\nExperiment rules: ${files.promptPath} — read this file at the start of every session and after compaction.` +
    "\nWrite promising but deferred optimizations as bullet points to .auto/ideas.md — don't let good ideas get lost." +
    `\n${BENCHMARK_GUARDRAIL}` +
    '\nIf the user sends a follow-on message while an experiment is running, finish the current run_experiment + log_experiment cycle first, then address their message in the next iteration.'

  if (files.checksPath) {
    text +=
      '\n\n## Backpressure Checks (ACTIVE)' +
      `\n${files.checksPath} exists and runs automatically after every passing benchmark in run_experiment.` +
      '\nIf the benchmark passes but checks fail, run_experiment will report it clearly.' +
      "\nUse status 'checks_failed' in log_experiment when this happens — it behaves like a crash (no commit, changes auto-reverted)." +
      "\nYou cannot use status 'keep' when checks have failed." +
      '\nThe checks execution time does NOT affect the primary metric.'
  }

  if (files.ideasPath) {
    text += `\n\n💡 Ideas backlog exists at ${files.ideasPath} — check it for promising experiment paths. Prune stale entries.`
  }
  return text
}

/** The section for the session as it stands on disk. */
export async function modeSection($: Pick<EngineInterface, 'fs' | 'session'>): Promise<string> {
  const existing = async (kind: 'ideas' | 'checks') => {
    const path = await sessionFile($, kind)
    return (await $.fs.exists(path)) ? path : null
  }
  return composeModeSection({
    promptPath: await sessionFile($, 'prompt'),
    ideasPath: await existing('ideas'),
    checksPath: await existing('checks'),
  })
}
