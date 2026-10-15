import type { EngineInterface } from 'claude-code'

import type { FileIO } from '../core/io.ts'

/** The core's FileIO backed by `$.fs`. */
export function fsIo($: Pick<EngineInterface, 'fs'>): FileIO {
  return {
    exists: path => $.fs.exists(path),
    isDirectory: async path => {
      const stat = await $.fs.stat(path).catch(() => undefined)
      return stat?.kind === 'dir'
    },
    readText: path => $.fs.read(path),
  }
}

/** Append `text` to a file, creating it (and its folders) when missing. */
export async function appendText($: Pick<EngineInterface, 'fs'>, path: string, text: string): Promise<void> {
  const current = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
  await $.fs.write(path, current + text)
}
