/**
 * `.auto/config.json` reading and work-dir resolution (ported from
 * pi-autoresearch `index.ts`). The config always lives in the session's cwd;
 * `workingDir` moves every other session file elsewhere.
 */

import type { FileIO } from "./io.ts";
import { sessionFilePath } from "./paths.ts";
import { isAbsolute, resolve } from "./pathutil.ts";

export interface AutoresearchConfig {
  maxIterations?: number;
  workingDir?: string;
}

/** Read the config file from `cwd`; `{}` when missing or invalid. */
export async function readConfig(io: FileIO, cwd: string): Promise<AutoresearchConfig> {
  try {
    const configPath = await sessionFilePath(io, cwd, "config");
    if (!(await io.exists(configPath))) return {};
    const parsed: unknown = JSON.parse(await io.readText(configPath));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as AutoresearchConfig)
      : {};
  } catch {
    return {};
  }
}

/** `maxIterations` as a positive integer, or null for unlimited. */
export function maxExperimentsFrom(config: AutoresearchConfig): number | null {
  return typeof config.maxIterations === "number" && config.maxIterations > 0
    ? Math.floor(config.maxIterations)
    : null;
}

export async function readMaxExperiments(io: FileIO, cwd: string): Promise<number | null> {
  return maxExperimentsFrom(await readConfig(io, cwd));
}

/** `cwd`, or `workingDir` resolved against it (absolute paths used as given). */
export function workDirFrom(cwd: string, config: AutoresearchConfig): string {
  if (!config.workingDir) return cwd;
  return isAbsolute(config.workingDir) ? config.workingDir : resolve(cwd, config.workingDir);
}

/** The effective working directory for the session files. */
export async function resolveWorkDir(io: FileIO, cwd: string): Promise<string> {
  return workDirFrom(cwd, await readConfig(io, cwd));
}

/** An error message when a configured `workingDir` is missing; null when OK. */
export async function validateWorkDir(io: FileIO, cwd: string): Promise<string | null> {
  const workDir = await resolveWorkDir(io, cwd);
  if (workDir === cwd) return null;
  if (!(await io.exists(workDir))) {
    return `workingDir "${workDir}" (from .auto/config.json) does not exist.`;
  }
  if (!(await io.isDirectory(workDir))) {
    return `workingDir "${workDir}" (from .auto/config.json) is not a directory.`;
  }
  return null;
}
