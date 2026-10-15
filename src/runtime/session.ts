// Session-level glue: where the session files are, and reloading the
// experiment state from them into `$.state`.

import type { EngineInterface } from 'claude-code'

import { resolveWorkDir } from '../core/config.ts'
import { sessionFilePath, type SessionFileKind } from '../core/paths.ts'
import { loadSession, type LoadedSession } from '../core/state.ts'
import { fsIo } from './fs.ts'
import { defaultAutoResume, defaultLastRun, setAutoResume, setExperiment, setLastRun, setPaths, setRunning } from './state.ts'

type Session$ = Pick<EngineInterface, 'fs' | 'session' | 'state'>

/** The effective work dir: `workingDir` from config, else the session's cwd. */
export async function sessionWorkDir($: Pick<EngineInterface, 'fs' | 'session'>): Promise<string> {
  return resolveWorkDir(fsIo($), await $.session.cwd())
}

/** The path in effect for one session file (current or legacy layout). */
export async function sessionFile($: Pick<EngineInterface, 'fs' | 'session'>, kind: SessionFileKind): Promise<string> {
  return sessionFilePath(fsIo($), await sessionWorkDir($), kind)
}

/** Rebuild the experiment state and the session paths from disk into `$.state`. */
export async function reloadExperiment($: Session$): Promise<LoadedSession> {
  const loaded = await loadSession(fsIo($), await $.session.cwd())
  await setExperiment($, loaded.state)
  await setPaths($, loaded.paths)
  return loaded
}

/** Reset the per-session runtime values, as upstream does on session start. */
export async function resetRuntime($: Pick<EngineInterface, 'state'>): Promise<void> {
  await setRunning($, null)
  await setLastRun($, defaultLastRun())
  await setAutoResume($, defaultAutoResume())
}
