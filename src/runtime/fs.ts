import type { EngineInterface } from 'claude-code'

import type { FileIO } from '../core/io.ts'

type Fs$ = Pick<EngineInterface, 'fs'>

/** The core's FileIO backed by `$.fs`. */
export function fsIo($: Fs$): FileIO {
  return {
    exists: path => $.fs.exists(path),
    isDirectory: async path => {
      const stat = await $.fs.stat(path).catch(() => undefined)
      return stat?.kind === 'dir'
    },
    readText: path => $.fs.read(path),
  }
}

// `$.fs` has no append: an append is a read and a whole-file write. Appends
// from this module run one at a time so two of them never lose a line.
let appendQueue: Promise<unknown> = Promise.resolve()

/**
 * Append `text` to a file, creating it (and its folders) when missing.
 * Bound by `$.fs`'s 4 MiB read/write limit, unlike upstream's appendFileSync.
 */
export function appendText($: Fs$, path: string, text: string): Promise<void> {
  const append = async () => {
    const current = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
    await $.fs.write(path, current + text)
  }
  const done = appendQueue.then(append, append)
  appendQueue = done.catch(() => undefined)
  return done
}

/**
 * The directory with every link and `..` resolved (upstream's canonicalPath):
 * the key `decisions` are recorded under. Falls back to `path` as given.
 */
export async function canonicalDir($: Fs$, path: string): Promise<string> {
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  return stat?.realPath ?? path
}
