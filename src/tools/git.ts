// log_experiment's git side, as upstream: commit everything on `keep`, revert
// the working tree on anything else while keeping the session files.

import type { EngineInterface } from 'claude-code'

import { AUTO_DIR } from '../core/paths.ts'

type Git$ = Pick<EngineInterface, 'process'>

const GIT_TIMEOUT_MS = 10_000

/** The commit message: the description, then a `Result:` JSON trailer. */
export function commitMessage(
  description: string,
  status: string,
  metricName: string,
  metric: number,
  metrics: Record<string, number>,
): string {
  const result: Record<string, unknown> = { status, [metricName || 'metric']: metric, ...metrics }
  return `${description}\n\nResult: ${JSON.stringify(result)}`
}

export type CommitOutcome = {
  /** The line for the tool result. */
  note: string
  /** The new short hash, when a commit was made. */
  sha: string | null
}

function output(result: { stdout: string; stderr: string }): string {
  return (result.stdout + result.stderr).trim()
}

/** `git add -A` and commit in `workDir`. */
export async function commitAll($: Git$, workDir: string, message: string): Promise<CommitOutcome> {
  const opts = { cwd: workDir, timeoutMs: GIT_TIMEOUT_MS }
  try {
    const add = await $.process.run(['git', 'add', '-A'], opts)
    if (add.exitCode !== 0) {
      throw new Error(`git add failed (exit ${add.exitCode}): ${output(add).slice(0, 200)}`)
    }

    const diff = await $.process.run(['git', 'diff', '--cached', '--quiet'], opts)
    if (diff.exitCode === 0) return { note: '📝 Git: nothing to commit (working tree clean)', sha: null }

    const commit = await $.process.run(['git', 'commit', '-m', message], opts)
    const commitOutput = output(commit)
    if (commit.exitCode !== 0) {
      return { note: `⚠️ Git commit failed (exit ${commit.exitCode}): ${commitOutput.slice(0, 200)}`, sha: null }
    }
    const note = `📝 Git: committed — ${commitOutput.split('\n')[0] || ''}`
    try {
      const rev = await $.process.run(['git', 'rev-parse', '--short=7', 'HEAD'], { cwd: workDir, timeoutMs: 5000 })
      const sha = rev.stdout.trim()
      return { note, sha: sha.length >= 7 ? sha : null }
    } catch {
      // Keep the hash the agent gave if rev-parse fails.
      return { note, sha: null }
    }
  } catch (error) {
    return { note: `⚠️ Git commit error: ${error instanceof Error ? error.message : String(error)}`, sha: null }
  }
}

/**
 * Upstream's revert: restore tracked files and remove untracked ones, except
 * the session files (`.auto/` and legacy `autoresearch.*`) at any depth.
 */
export const REVERT_SCRIPT = `
            git checkout -- . ':(exclude,glob)**/${AUTO_DIR}' ':(exclude,glob)**/${AUTO_DIR}/**' ':(exclude,glob)**/autoresearch.*' ':(exclude,glob)**/autoresearch.*/**'
            git clean -fd -e '${AUTO_DIR}' -e '**/${AUTO_DIR}/**' -e 'autoresearch.*' -e '**/autoresearch.*/**' 2>/dev/null
          `

/** Revert the working tree in `workDir`; answers the line for the tool result. */
export async function revertChanges($: Git$, workDir: string, status: string): Promise<string> {
  try {
    await $.process.run(['bash', '-c', REVERT_SCRIPT], { cwd: workDir, timeoutMs: GIT_TIMEOUT_MS })
    return `📝 Git: reverted changes (${status}) — autoresearch files preserved`
  } catch (error) {
    return `⚠️ Git revert failed: ${error instanceof Error ? error.message : String(error)}`
  }
}
