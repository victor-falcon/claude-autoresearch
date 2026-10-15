// A fake host beneath the mod for tool tests: an in-memory file system, a
// tiny git (one snapshot per commit), and scripted shell commands. The mod
// runs without Node, so a real temp repo is exercised by the headless QA.

import type { On, PluginState } from 'claude-code'
import { mock, type MockClock } from 'claude-code/testing'

export type Written = Partial<PluginState['autoresearch']>

export type ScriptRun = { stdout?: string; stderr?: string; code?: number; hang?: boolean }
export type ScriptHandler = (input: string | undefined) => ScriptRun

const SESSION_FILE = /(^|\/)(\.auto(\/|$)|autoresearch\.)/

export class World {
  readonly files = new Map<string, string>()
  readonly executables = new Set<string>()
  /** Committed contents, by path: the last commit's tree. */
  private committed = new Map<string, string>()
  readonly commits: { sha: string; message: string; files: Map<string, string> }[] = []
  /** Every argv run through `$.process.run`, and every spawned command line. */
  readonly ran: string[][] = []
  readonly spawned: string[] = []
  readonly state: Written = {}
  /** Shell command lines (as the tool got them) or `bash '<path>'` → what they do. */
  readonly scripts = new Map<string, ScriptHandler>()
  invalidated = 0
  /** Lines the mod wrote with `$.ui.log`. */
  readonly logs: string[] = []
  clock!: MockClock

  constructor(readonly cwd: string, files: Record<string, string> = {}) {
    for (const [path, text] of Object.entries(files)) this.files.set(`${cwd}/${path}`, text)
    this.commitTree()
  }

  file(path: string): string | undefined {
    return this.files.get(`${this.cwd}/${path}`)
  }

  write(path: string, text: string): void {
    this.files.set(`${this.cwd}/${path}`, text)
  }

  logLines(): Record<string, unknown>[] {
    return (this.file('.auto/log.jsonl') ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line))
  }

  /** `bash '<cwd>/<path>'` runs `handler`, the script being executable. */
  script(path: string, handler: ScriptHandler, executable = true): void {
    this.write(path, '#!/bin/bash\n')
    if (executable) this.executables.add(`${this.cwd}/${path}`)
    this.scripts.set(`bash '${this.cwd}/${path}'`, handler)
  }

  private isDir(path: string): boolean {
    const prefix = path.endsWith('/') ? path : `${path}/`
    for (const file of this.files.keys()) if (file.startsWith(prefix)) return true
    return false
  }

  private commitTree(): void {
    this.committed = new Map([...this.files].filter(([path]) => !SESSION_FILE.test(path.slice(this.cwd.length + 1))))
  }

  private dirty(): boolean {
    const tracked = [...this.files].filter(([path]) => !SESSION_FILE.test(path.slice(this.cwd.length + 1)))
    if (tracked.length !== this.committed.size) return true
    return tracked.some(([path, text]) => this.committed.get(path) !== text)
  }

  private git(argv: readonly string[]): { exitCode: number; stdout: string; stderr: string } {
    const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' })
    const [, verb] = argv
    if (verb === 'add') return ok()
    if (verb === 'diff') return { exitCode: this.dirty() ? 1 : 0, stdout: '', stderr: '' }
    if (verb === 'commit') {
      const sha = `c0ffee${this.commits.length}`.padEnd(7, '0')
      this.commitTree()
      this.commits.push({ sha, message: argv[3] ?? '', files: new Map(this.committed) })
      return ok(`[main ${sha}] ${(argv[3] ?? '').split('\n')[0]}\n 1 file changed`)
    }
    if (verb === 'rev-parse') return ok(`${this.commits.at(-1)?.sha ?? '0000000'}\n`)
    if (verb === 'log') return ok(this.commits.map(c => `${c.sha} ${c.message.split('\n')[0]}\n`).reverse().join(''))
    return { exitCode: 1, stdout: '', stderr: `fake git: ${argv.join(' ')}` }
  }

  /** The revert script: tracked files back to the last commit, untracked removed. */
  private revert(): void {
    for (const path of [...this.files.keys()]) {
      if (SESSION_FILE.test(path.slice(this.cwd.length + 1))) continue
      if (!this.committed.has(path)) this.files.delete(path)
    }
    for (const [path, text] of this.committed) this.files.set(path, text)
  }

  /** Install the world's hooks beneath the plugin. */
  install(on: On, options: { enabled?: boolean } = {}): void {
    const enabled = options.enabled ?? true
    this.clock = mock.clock(on, { now: 1_000 })
    on('state.get', ($, e, next) => {
      if (e.plugin === 'autoresearch' && e.key === 'enabled' && !('enabled' in this.state)) {
        return { value: { value: enabled, version: 1 } }
      }
      return next(e)
    })
    on('state.set', ($, e, next) => {
      if (e.plugin === 'autoresearch') (this.state as Record<string, unknown>)[e.key] = e.value
      return next(e)
    })
    on('session.cwd', () => ({ value: this.cwd }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('tool.register', ($, e) => ({ value: { tool: `mcp__autoresearch__${e.name}` } }))
    on('ui.invalidate', () => {
      this.invalidated++
      return { value: undefined }
    })
    on('ui.log', ($, e) => {
      this.logs.push(e.text)
      return { value: undefined }
    })
    on('env.get', () => ({ value: undefined }))
    on('fs.exists', ($, e) => ({ value: this.files.has(e.path) || this.isDir(e.path) }))
    on('fs.stat', ($, e) => {
      if (this.files.has(e.path)) {
        return { value: { kind: 'file' as const, size: this.files.get(e.path)!.length, mtimeMs: 0, isLink: false, realPath: e.path } }
      }
      if (this.isDir(e.path)) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }
      throw new Error(`ENOENT: ${e.path}`)
    })
    on('fs.read', ($, e) => {
      const text = this.files.get(e.path)
      if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
      return { value: text }
    })
    on('fs.write', ($, e) => {
      this.files.set(e.path, e.text)
      return { value: undefined }
    })
    on('process.run', ($, e) => {
      this.ran.push([...e.argv])
      if (e.argv[0] === 'git') return { value: { ...this.git(e.argv), isStdoutTruncated: false, isStderrTruncated: false } }
      if (e.argv[0] === 'test' && e.argv[1] === '-x') {
        return { value: { exitCode: this.executables.has(e.argv[2]!) ? 0 : 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      }
      if (e.argv[0] === 'rm') {
        for (const path of e.argv.slice(1).filter(arg => !arg.startsWith('-'))) this.files.delete(path)
        return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      }
      if (e.argv[0] === 'bash' && String(e.argv[2]).includes('git checkout')) {
        this.revert()
        return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      }
      throw new Error(`fake host: no command ${e.argv.join(' ')}`)
    })
    // Commands run as `bash -c <group wrapper> autoresearch <command line>`.
    const world = this
    on('process.spawn', async function* ($, e) {
      const command = String(e.argv[4])
      world.spawned.push(command)
      const handler = world.scripts.get(command)
      if (!handler) throw new Error(`fake host: no script for ${command}`)
      const run = handler(e.input)
      if (run.stdout) yield { stream: 'stdout' as const, text: run.stdout }
      if (run.stderr) yield { stream: 'stderr' as const, text: run.stderr }
      // A process that never ends on its own: it ticks until the stream is ended.
      while (run.hang) {
        await world.clock.sleep(100)
        yield { stream: 'stdout' as const, text: '.' }
      }
      return { value: { code: run.code ?? 0, signal: null } }
    })
  }
}

export async function startSession($: { session: { start: (e: { cwd: string; surface: null; isInteractive: boolean }) => Promise<unknown> } }, world: World): Promise<void> {
  await $.session.start({ cwd: world.cwd, surface: null, isInteractive: false })
}
