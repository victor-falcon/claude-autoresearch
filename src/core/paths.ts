/**
 * Session file path resolution (ported from pi-autoresearch `paths.ts`).
 *
 * All autoresearch session files live under a single `.auto/` subfolder. New
 * sessions always write the `.auto/` layout. For backwards compatibility the
 * legacy flat `autoresearch.*` files are still read when only those exist.
 */

import type { FileIO } from "./io.ts";
import { join } from "./pathutil.ts";

export const AUTO_DIR = ".auto";

export type SessionFileKind = "log" | "prompt" | "ideas" | "checks" | "measure" | "config";
export type HookStage = "before" | "after";

const CURRENT_HOOKS_DIR = "hooks";
const LEGACY_HOOKS_DIR = "autoresearch.hooks";

const SESSION_FILE_NAMES: Record<SessionFileKind, { current: string; legacy: string }> = {
  log:     { current: "log.jsonl",   legacy: "autoresearch.jsonl" },
  prompt:  { current: "prompt.md",   legacy: "autoresearch.md" },
  ideas:   { current: "ideas.md",    legacy: "autoresearch.ideas.md" },
  checks:  { current: "checks.sh",   legacy: "autoresearch.checks.sh" },
  measure: { current: "measure.sh",  legacy: "autoresearch.sh" },
  config:  { current: "config.json", legacy: "autoresearch.config.json" },
};

export const SESSION_FILE_KINDS = Object.keys(SESSION_FILE_NAMES) as SessionFileKind[];

export interface SessionFileCandidates {
  current: string;
  legacy: string;
}

function currentSessionPath(dir: string, kind: SessionFileKind): string {
  return join(dir, AUTO_DIR, SESSION_FILE_NAMES[kind].current);
}

function legacySessionPath(dir: string, kind: SessionFileKind): string {
  return join(dir, SESSION_FILE_NAMES[kind].legacy);
}

function currentHookPath(workDir: string, stage: HookStage): string {
  return join(workDir, AUTO_DIR, CURRENT_HOOKS_DIR, `${stage}.sh`);
}

function legacyHookPath(workDir: string, stage: HookStage): string {
  return join(workDir, LEGACY_HOOKS_DIR, `${stage}.sh`);
}

async function currentLayoutExists(io: FileIO, dir: string): Promise<boolean> {
  for (const kind of SESSION_FILE_KINDS) {
    if (await io.exists(currentSessionPath(dir, kind))) return true;
  }
  return io.exists(join(dir, AUTO_DIR, CURRENT_HOOKS_DIR));
}

/** Both physical paths, for destructive or migration operations. */
export function sessionFileCandidates(dir: string, kind: SessionFileKind): SessionFileCandidates {
  return {
    current: currentSessionPath(dir, kind),
    legacy: legacySessionPath(dir, kind),
  };
}

/** Both physical hook script paths, for cleanup. */
export function hookScriptCandidates(workDir: string, stage: HookStage): SessionFileCandidates {
  return {
    current: currentHookPath(workDir, stage),
    legacy: legacyHookPath(workDir, stage),
  };
}

/**
 * Effective path for a session file. If any current `.auto/` session artifact
 * exists, stay in the current layout for every file and ignore stale legacy
 * peers. Fall back to a legacy flat file only when no current layout exists.
 */
export async function sessionFilePath(io: FileIO, dir: string, kind: SessionFileKind): Promise<string> {
  const candidates = sessionFileCandidates(dir, kind);
  if (await currentLayoutExists(io, dir)) return candidates.current;
  return (await io.exists(candidates.legacy)) ? candidates.legacy : candidates.current;
}

/** Effective path for a hook script, with the same layout choice as session files. */
export async function hookScriptPath(io: FileIO, workDir: string, stage: HookStage): Promise<string> {
  const { current, legacy } = hookScriptCandidates(workDir, stage);
  if (await currentLayoutExists(io, workDir)) return current;
  return (await io.exists(legacy)) ? legacy : current;
}
