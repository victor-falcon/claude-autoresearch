#!/usr/bin/env node
// The live server behind /autoresearch export, a port of pi-autoresearch's
// static dashboard server. The mod has no Node of its own, so it starts this
// script with `$.process.spawn` and keeps it for as long as it wants it.
//
//   node dashboard-server.mjs <session log>  < dashboard.html
//
// Reads the dashboard HTML from stdin (so no file of it lies in a shared temp
// dir), then binds 127.0.0.1 on a free port and prints `listening <port>`.
// Serves:
//   /                    the dashboard HTML
//   /autoresearch.jsonl  the session log
//   /events              Server-Sent Events: `jsonl-updated` whenever the log
//                        changes on disk, whoever wrote it
// Anything else is a 404. Exits when its parent (Claude Code) goes away.

import { readFile, readFileSync, watchFile } from 'node:fs'
import { createServer } from 'node:http'

const LOG_POLL_MS = 250
const HEARTBEAT_MS = 15_000
const PARENT_POLL_MS = 2_000

const [logPath] = process.argv.slice(2)
if (!logPath) {
  process.stderr.write('usage: dashboard-server.mjs <session log> < dashboard.html\n')
  process.exit(2)
}
const html = readFileSync(0)

const clients = new Set()

function serveFile(res, path, contentType) {
  readFile(path, (err, data) => {
    if (err) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' })
    res.end(data)
  })
}

function registerSseClient(res) {
  res.on('error', () => clients.delete(res))
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.write('retry: 1000\n\n')
  clients.add(res)
  res.on('close', () => clients.delete(res))
}

function writeAll(text) {
  for (const res of clients) {
    try {
      res.write(text)
    } catch {
      clients.delete(res)
    }
  }
}

const server = createServer((req, res) => {
  // Only this machine's own names: a page elsewhere that rebinds its DNS to
  // 127.0.0.1 must not read the session log. Reads only (GET/HEAD) and no
  // CORS headers, so no other origin reads or changes anything either.
  const port = server.address().port
  if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
    res.writeHead(403)
    res.end()
    return
  }
  const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405)
    res.end()
  } else if (pathname === '/events' && req.method === 'GET') {
    registerSseClient(res)
  } else if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(html)
  } else if (pathname === '/autoresearch.jsonl') {
    serveFile(res, logPath, 'text/plain; charset=utf-8')
  } else {
    res.writeHead(404)
    res.end()
  }
})

server.on('error', err => {
  process.stderr.write(`dashboard server: ${err.message}\n`)
  process.exit(1)
})

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`listening ${server.address().port}\n`)
})

// Polling, like upstream's broadcast after each write, but for any writer
// (log_experiment, init_experiment, a hook, another agent) and across the log
// being deleted and written again.
watchFile(logPath, { interval: LOG_POLL_MS }, (curr, prev) => {
  if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) writeAll(`event: jsonl-updated\ndata: ${Date.now()}\n\n`)
})

// Keeps idle connections from being dropped by proxies and browsers.
setInterval(() => writeAll(': ping\n\n'), HEARTBEAT_MS)

// Claude Code ends this process when it stops wanting it; if Claude Code
// itself dies first, this process is re-parented, and leaves too.
const parent = process.ppid
setInterval(() => {
  if (process.ppid !== parent) process.exit(0)
}, PARENT_POLL_MS)
