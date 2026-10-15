// /autoresearch export against a fake host: an in-memory file system, a fake
// `node` server process and a recorded browser launcher, driven through the
// plugin's own `/autoresearch` command. The real server
// (assets/dashboard-server.mjs) is tested with Node in tests/export.

import type { CommandRunInput, On } from 'claude-code'
import { expect, test, type Engine } from 'claude-code/testing'

import { escapeHtml, injectDataIntoTemplate } from '../../src/export/template.ts'

// The test kit runs on a JavaScript runtime with timers; the mod types do not declare them.
declare const setTimeout: (callback: () => void, ms: number) => unknown

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function autoresearch($: Engine, args: string): Promise<string> {
  const input = { command: 'autoresearch', args } as CommandRunInput
  return (await $.command.run(input)).text ?? ''
}

const TEMPLATE = '<title>__AUTORESEARCH_TITLE__</title><script>const SHARE_LOGO_URL = \'__AUTORESEARCH_LOGO__\';</script>'
const LOG = '/repo/.auto/log.jsonl'

type Server = { argv: string[]; stopped: boolean }
type Spawn = { listen?: string; stderr?: string; fail?: string }

class Host {
  readonly files = new Map<string, string>()
  readonly servers: Server[] = []
  readonly opened: string[][] = []
  spawn: Spawn = { listen: 'listening 4242\n' }
  uname = 'Darwin\n'

  constructor(log: string | null) {
    if (log !== null) this.files.set(LOG, log)
  }

  get running(): Server[] {
    return this.servers.filter(server => !server.stopped)
  }

  html(): string {
    const pages = [...this.files].filter(([path]) => path.endsWith('/index.html'))
    return pages.at(-1)?.[1] ?? ''
  }

  install(on: On): void {
    on('session.cwd', () => ({ value: '/repo' }))
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))
    on('env.get', ($, e) => ({ value: e.name === 'TMPDIR' ? '/tmp/t/' : undefined }))
    on('fs.exists', ($, e) => ({ value: this.files.has(e.path) }))
    on('fs.read', ($, e) => {
      if (e.path.endsWith('/assets/template.html')) return { value: TEMPLATE }
      if (e.path.endsWith('/assets/logo.webp') && e.as === 'bytes') return { value: { base64: 'TE9HTw==' } }
      const text = this.files.get(e.path)
      if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
      return { value: text }
    })
    on('fs.write', ($, e) => {
      this.files.set(e.path, e.text)
      return { value: undefined }
    })
    on('process.run', ($, e) => {
      const done = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
      if (e.argv[0] === 'uname') return done(this.uname)
      this.opened.push([...e.argv])
      return done()
    })
    const host = this
    on('process.spawn', async function* ($, e) {
      if (host.spawn.fail) throw new Error(host.spawn.fail)
      const server: Server = { argv: [...e.argv], stopped: false }
      host.servers.push(server)
      try {
        if (host.spawn.stderr) yield { stream: 'stderr' as const, text: host.spawn.stderr }
        if (!host.spawn.listen) return { value: { code: 1, signal: null } }
        yield { stream: 'stdout' as const, text: host.spawn.listen }
        // Serves until the mod ends the stream.
        for (;;) {
          await sleep(5)
          yield { stream: 'stderr' as const, text: '.' }
        }
      } finally {
        server.stopped = true
      }
    })
  }
}

test('escapeHtml escapes the five HTML metacharacters', () => {
  expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;')
})

test('the session name cannot break out of the title', () => {
  const html = injectDataIntoTemplate(TEMPLATE, '</title><script>alert(1)</script>', 'data:image/webp;base64,AA==')
  expect(html).toContain('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>')
  expect(html).not.toContain('<script>alert(1)')
  expect(html).toContain("const SHARE_LOGO_URL = 'data:image/webp;base64,AA==';")
})

test('replacement patterns and placeholders in the session name stay literal', () => {
  const html = injectDataIntoTemplate(TEMPLATE, "$& $' __AUTORESEARCH_LOGO__", 'LOGO')
  expect(html).toContain("<title>$&amp; $&#39; __AUTORESEARCH_LOGO__</title>")
  expect(html).toContain("const SHARE_LOGO_URL = 'LOGO';")
})

test('without a session log there is nothing to export', async ($, on) => {
  const host = new Host(null)
  host.install(on)

  expect(await autoresearch($, 'export')).toBe('No .auto/log.jsonl found — run some experiments first')
  expect(host.servers.length).toBe(0)
  expect(host.opened.length).toBe(0)
})

test('export writes the page, serves it with node, opens the browser and answers the URL', async ($, on) => {
  const host = new Host('{"type":"config","name":"Speed <up>","metricName":"ms","metricUnit":"ms","bestDirection":"lower"}\n')
  host.install(on)

  const text = await autoresearch($, 'export')
  expect(text).toBe('Dashboard at http://127.0.0.1:4242 (live updates)')

  const [server] = host.servers
  expect(server?.argv[0]).toBe('node')
  expect(server?.argv[1]?.endsWith('/assets/dashboard-server.mjs')).toBe(true)
  expect(server?.argv[2]).toMatch(/^\/tmp\/t\/autoresearch-dashboard-[0-9a-f]{16}\/index\.html$/)
  expect(server?.argv[3]).toBe(LOG)
  expect(host.files.get(server!.argv[2]!)).toBe(
    "<title>Speed &lt;up&gt;</title><script>const SHARE_LOGO_URL = 'data:image/webp;base64,TE9HTw==';</script>",
  )
  expect(host.opened).toEqual([['open', 'http://127.0.0.1:4242']])
  expect(host.running.length).toBe(1)
})

test('xdg-open opens the browser outside macOS', async ($, on) => {
  const host = new Host('{"type":"config","name":"x"}\n')
  host.uname = 'Linux\n'
  host.install(on)

  await autoresearch($, 'export')
  expect(host.opened).toEqual([['xdg-open', 'http://127.0.0.1:4242']])
})

test('a second export reuses the running server and refreshes the page', async ($, on) => {
  const host = new Host('{"type":"config","name":"First"}\n')
  host.install(on)

  await autoresearch($, 'export')
  host.files.set(LOG, '{"type":"config","name":"Second"}\n')
  const again = await autoresearch($, 'export')

  expect(again).toBe('Dashboard at http://127.0.0.1:4242 (live updates)')
  expect(host.servers.length).toBe(1)
  expect(host.html()).toContain('<title>Second</title>')
  expect(host.opened.length).toBe(2)
})

test('turning the mode off stops the server; the next export starts a new one', async ($, on) => {
  const host = new Host('{"type":"config","name":"x"}\n')
  host.install(on)

  await autoresearch($, 'export')
  expect(host.running.length).toBe(1)

  await autoresearch($, 'off')
  await sleep(20)
  expect(host.running.length).toBe(0)

  await autoresearch($, 'export')
  expect(host.servers.length).toBe(2)
  expect(host.running.length).toBe(1)
})

test('the session ending stops the server', async ($, on) => {
  const host = new Host('{"type":"config","name":"x"}\n')
  host.install(on)

  await autoresearch($, 'export')
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's', resume: { id: 's' } })
  await sleep(20)
  expect(host.running.length).toBe(0)
})

test('a missing node is reported with what the dashboard needs', async ($, on) => {
  const host = new Host('{"type":"config","name":"x"}\n')
  host.spawn = { fail: 'spawn node ENOENT' }
  host.install(on)

  const text = await autoresearch($, 'export')
  expect(text).toContain('Export failed: could not run node (')
  expect(text).toContain('needs Node.js on your PATH')
  expect(host.opened.length).toBe(0)
})

test('a server that exits before listening reports its stderr', async ($, on) => {
  const host = new Host('{"type":"config","name":"x"}\n')
  host.spawn = { stderr: 'dashboard server: listen EPERM\n' }
  host.install(on)

  const text = await autoresearch($, 'export')
  expect(text).toBe('Export failed: the dashboard server exited before listening:\ndashboard server: listen EPERM')
})
