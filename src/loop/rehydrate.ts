// What the model is sent after Claude Code compacts the conversation while the
// mode is on. Upstream replaced pi's compaction summary with a deterministic
// one; here the engine's summary stays and the follow-up prompt carries the
// persisted state instead: rules, ideas, recent runs, and recent commits.

import type { EngineInterface } from 'claude-code'

import { composeCompactionResumeMessage } from '../core/autoresume.ts'
import { buildAutoresearchCompactionSummary } from '../core/compaction.ts'
import { fsIo, sessionWorkDir } from '../runtime/index.ts'

const RECENT_COMMIT_LIMIT = 10

async function recentCommits($: Pick<EngineInterface, 'process'>, workDir: string): Promise<string> {
  try {
    const log = await $.process.run(['git', 'log', '--oneline', '-n', String(RECENT_COMMIT_LIMIT)], { cwd: workDir })
    const lines = log.exitCode === 0 ? log.stdout.trim() : ''
    return lines ? `## Recent Commits (git log --oneline -n ${RECENT_COMMIT_LIMIT})\n\n${lines}` : ''
  } catch {
    return ''
  }
}

/** The rehydration prompt: the compaction summary, recent commits and the resume nudge. */
export async function composeRehydrationMessage($: Pick<EngineInterface, 'fs' | 'session' | 'process'>): Promise<string> {
  const workDir = await sessionWorkDir($)
  const summary = await buildAutoresearchCompactionSummary(fsIo($), workDir)
  return [summary, await recentCommits($, workDir), composeCompactionResumeMessage()].filter(Boolean).join('\n\n')
}
