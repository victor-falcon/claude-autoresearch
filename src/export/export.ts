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
import { injectDataIntoTemplate } from './template.ts'

type Export$ = Pick<EngineInterface, 'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session'>

/** How long `node` may take to print its port before the export gives up. */
const START_TIMEOUT_MS = 10_000
const OPEN_TIMEOUT_MS = 10_000
const LISTENING = /^listening (\d+)$/m

type DashboardServer = {
  logPath: string
  htmlPath: string
  url: string
  stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>
}

let server: DashboardServer | null = null
let cachedLogoDataUrl: string | null = null
let cachedOpener: string[] | null = null
/** Exports run one at a time, so two never start two servers. */
let queue: Promise<unknown> = Promise.resolve()

/**
 * Write the dashboard, serve it on 127.0.0.1 with live updates, open the
 * browser, and answer the text shown to the user. Reuses the running server
 * when it serves the same log.
 */
export function exportDashboard($: Export$, _args: string): Promise<string> {
  const run = queue.then(() => exportNow($))
  queue = run.catch(() => undefined)
  return run
}

/** Stop the dashboard server, if one runs. Safe to call at any time. */
export function stopDashboardServer(): void {
  const running = server
  server = null
  if (running) void running.stream.return(undefined as never).catch(() => undefined)
}

async function exportNow($: Export$): Promise<string> {
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
    let running = server?.logPath === logPath ? server : null
    if (running) {
      await $.fs.write(running.htmlPath, html)
    } else {
      stopDashboardServer()
      const htmlPath = `${await tempDir($)}/autoresearch-dashboard-${randomId()}/index.html`
      await $.fs.write(htmlPath, html)
      running = await startServer($, htmlPath, logPath)
    }
    await openInBrowser($, running.url)
    return `Dashboard at ${running.url} (live updates)`
  } catch (error) {
    return `Export failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** The first config header's name, as upstream; the default when unreadable. */
async function sessionName($: Export$, logPath: string): Promise<string> {
  try {
    return extractAutoresearchSessionName(await $.fs.read(logPath))
  } catch {
    // Over $.fs's 4 MiB read cap: the server still serves the whole log.
    return extractAutoresearchSessionName('')
  }
}

async function logoDataUrl($: Export$): Promise<string> {
  if (cachedLogoDataUrl) return cachedLogoDataUrl
  const { base64 } = await $.fs.read(`${$.plugin.root}/assets/logo.webp`, { as: 'bytes' })
  cachedLogoDataUrl = `data:image/webp;base64,${base64}`
  return cachedLogoDataUrl
}

async function tempDir($: Export$): Promise<string> {
  return ((await $.env.get('TMPDIR')) || '/tmp').replace(/\/+$/, '')
}

function randomId(): string {
  let id = ''
  for (let i = 0; i < 16; i++) id += Math.floor(Math.random() * 16).toString(16)
  return id
}

/**
 * Start assets/dashboard-server.mjs and resolve once it prints its port. The
 * stream is then read in the background for the server's whole life; when
 * the server exits on its own, it is forgotten so the next export starts one.
 */
function startServer($: Export$, htmlPath: string, logPath: string): Promise<DashboardServer> {
  const stream = $.process.spawn({ argv: ['node', `${$.plugin.root}/assets/dashboard-server.mjs`, htmlPath, logPath] })
  const stop = () => void stream.return(undefined as never).catch(() => undefined)

  return new Promise((resolve, reject) => {
    let started: DashboardServer | null = null
    let stdout = ''
    let stderr = ''
    const timer = $.clock.after(START_TIMEOUT_MS, () => {
      stop()
      reject(new Error(`the dashboard server did not start within ${START_TIMEOUT_MS / 1000}s`))
    })

    void (async () => {
      let failure: string | null = null
      try {
        for await (const { stream: pipe, text } of stream) {
          if (started) continue
          if (pipe === 'stderr') {
            stderr += text
            continue
          }
          stdout += text
          const port = LISTENING.exec(stdout)?.[1]
          if (!port) continue
          timer.cancel()
          started = { logPath, htmlPath, url: `http://127.0.0.1:${port}`, stream }
          server = started
          resolve(started)
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
      if (server === started) server = null
      if (started) return
      timer.cancel()
      reject(new Error(startFailure(failure, stderr)))
    })()
  })
}

function startFailure(spawnError: string | null, stderr: string): string {
  // The first pull rejects when `node` cannot be started at all.
  if (spawnError) return `could not run node (${spawnError}); the browser dashboard needs Node.js on your PATH`
  const detail = stderr.trim().split('\n').slice(-5).join('\n')
  return `the dashboard server exited before listening${detail ? `:\n${detail}` : ''}`
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
  if (!uname || uname.exitCode !== 0) cachedOpener = ['cmd', '/c', 'start', '""']
  else cachedOpener = uname.stdout.trim() === 'Darwin' ? ['open'] : ['xdg-open']
  return cachedOpener
}
