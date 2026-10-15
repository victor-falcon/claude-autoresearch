// /autoresearch export: the browser dashboard with live updates, a port of
// upstream's exportDashboard / startStaticServer / openInBrowser.
//
// The mod has no Node, so the HTTP + SSE server is assets/dashboard-server.mjs,
// run with the user's `node` through `$.process.spawn`. It lives as long as
// the spawn's stream is read: `stopDashboardServer` (or the module unloading)
// ends it. It watches the session log itself, so the page updates after each
// `log_experiment` (or any other write) without the tools calling into here.

import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'

import { extractAutoresearchSessionName } from '../core/jsonl.ts'
import { relative } from '../core/pathutil.ts'
import { sessionFile, sessionWorkDir } from '../runtime/session.ts'
import { getExperiment } from '../runtime/state.ts'
import { injectDataIntoTemplate } from './template.ts'

type Export$ = Pick<EngineInterface, 'clock' | 'fs' | 'plugin' | 'process' | 'session' | 'state'>
type ServerStream = HookStream<ProcessSpawnChunk, ProcessSpawnResult>

/** How long `node` may take to print its port before the export gives up. */
const START_TIMEOUT_MS = 10_000
const OPEN_TIMEOUT_MS = 10_000
const LISTENING = /^listening (\d+)$/m

type DashboardServer = {
  logPath: string
  /** The page it serves, to tell whether the next export can reuse it. */
  html: string
  url: string
  stream: ServerStream
}

// A live process handle cannot be kept in `$.state`, so the server is module
// state; the module unloading ends the process with it.
let server: DashboardServer | null = null
/** Bumped by every stop, so a start still waiting for its port ends itself. */
let generation = 0
let cachedOpener: string[] | null = null
/** Exports run one at a time, so two never start two servers. */
let queue: Promise<unknown> = Promise.resolve()

/**
 * Build the dashboard, serve it on 127.0.0.1 with live updates, open the
 * browser, and answer the text shown to the user. Reuses the running server
 * when it serves the same log and page. `args` is the command's contract;
 * export takes none, as upstream.
 */
export function exportDashboard($: Export$, _args: string): Promise<string> {
  const run = queue.then(() => exportNow($))
  queue = run.catch(() => undefined)
  return run
}

/** Stop the dashboard server, if one runs or is starting. Safe at any time. */
export function stopDashboardServer(): void {
  generation++
  endServer()
}

function endServer(): void {
  const running = server
  server = null
  if (running) endStream(running.stream)
}

/** Ending the stream kills the process (`$.process.spawn`). */
function endStream(stream: ServerStream): void {
  void stream.return(undefined as never).catch(() => undefined)
}

async function exportNow($: Export$): Promise<string> {
  // A stop from here on (mode off, session end) cancels this export's server.
  const startedIn = generation
  const workDir = await sessionWorkDir($)
  const logPath = await sessionFile($, 'log')
  if (!(await $.fs.exists(logPath))) {
    return `No ${relative(workDir, logPath)} found — run some experiments first`
  }

  try {
    const html = injectDataIntoTemplate(
      await $.fs.read(`${$.plugin.root}/assets/template.html`),
      await sessionName($, logPath),
      await logoDataUrl($),
    )
    let running = server
    if (running?.logPath !== logPath || running.html !== html) {
      endServer()
      running = await startServer($, logPath, html, startedIn)
      server = running
    }
    await openInBrowser($, running.url)
    return `Dashboard at ${running.url} (live updates)`
  } catch (error) {
    return `Export failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** The first config header's name, as upstream. */
async function sessionName($: Export$, logPath: string): Promise<string> {
  try {
    return extractAutoresearchSessionName(await $.fs.read(logPath))
  } catch {
    // Over $.fs's 4 MiB read cap: the session's name as loaded at start (the
    // server still serves the whole log).
    return (await getExperiment($)).name || extractAutoresearchSessionName('')
  }
}

async function logoDataUrl($: Export$): Promise<string> {
  const { base64 } = await $.fs.read(`${$.plugin.root}/assets/logo.webp`, { as: 'bytes' })
  return `data:image/webp;base64,${base64}`
}

/**
 * Start assets/dashboard-server.mjs with the page on its stdin, and resolve
 * once it listens. Its output is then drained for the server's whole life.
 * Fails if a stop came after `startedIn` (a generation).
 */
async function startServer($: Export$, logPath: string, html: string, startedIn: number): Promise<DashboardServer> {
  const stream = $.process.spawn({ argv: ['node', `${$.plugin.root}/assets/dashboard-server.mjs`, logPath], input: html })
  let timedOut = false
  const timer = $.clock.after(START_TIMEOUT_MS, () => {
    timedOut = true
    endStream(stream)
  })
  const outcome = await readUntilListening(stream).finally(() => timer.cancel())
  if (timedOut) throw new Error(`the dashboard server did not start within ${START_TIMEOUT_MS / 1000}s`)
  if ('error' in outcome) throw new Error(outcome.error)
  if (generation !== startedIn) {
    endStream(stream)
    throw new Error('the dashboard was stopped while it started')
  }
  const started = { logPath, html, url: `http://127.0.0.1:${outcome.port}`, stream }
  void superviseServer(started)
  return started
}

/**
 * Read the server's output up to `listening <port>`. Pulls with `next()`
 * rather than `for await`, whose exit would end the stream and the server.
 */
async function readUntilListening(stream: ServerStream): Promise<{ port: string } | { error: string }> {
  let stdout = ''
  let stderr = ''
  try {
    for (;;) {
      const step = await stream.next()
      if (step.done) break
      if (step.value.stream === 'stderr') {
        stderr += step.value.text
        continue
      }
      stdout += step.value.text
      const port = LISTENING.exec(stdout)?.[1]
      if (port) return { port }
    }
  } catch (error) {
    // The first pull rejects when `node` cannot be started at all.
    const reason = error instanceof Error ? error.message : String(error)
    return { error: `could not run node (${reason}); the browser dashboard needs Node.js on your PATH` }
  }
  const detail = stderr.trim().split('\n').slice(-5).join('\n')
  return { error: `the dashboard server exited before listening${detail ? `:\n${detail}` : ''}` }
}

/** Drain a listening server's output; once it exits, forget it. */
async function superviseServer(started: DashboardServer): Promise<void> {
  try {
    while (!(await started.stream.next()).done) {
      // The server writes nothing more; this only waits for its end.
    }
  } catch {
    // Ended from outside.
  }
  if (server === started) server = null
}

/**
 * Open `url` in the default browser: `open` on macOS, `xdg-open` elsewhere,
 * `start` on Windows. A launcher that fails is ignored, as upstream: the
 * returned text carries the URL.
 */
async function openInBrowser($: Export$, url: string): Promise<void> {
  const opener = await browserOpener($)
  await $.process.run([...opener, url], { timeoutMs: OPEN_TIMEOUT_MS }).catch(() => undefined)
}

async function browserOpener($: Export$): Promise<string[]> {
  if (cachedOpener) return cachedOpener
  const uname = await $.process.run(['uname', '-s']).catch(() => null)
  // No `uname`: Windows. Only a real answer is kept for the session.
  if (!uname || uname.exitCode !== 0) return ['cmd', '/c', 'start', '""']
  cachedOpener = uname.stdout.trim() === 'Darwin' ? ['open'] : ['xdg-open']
  return cachedOpener
}
