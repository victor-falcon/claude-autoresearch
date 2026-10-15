// The real dashboard server (assets/dashboard-server.mjs) and template, run
// with Node: what it serves, what it refuses, and the live update event.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

const SERVER = new URL('../../assets/dashboard-server.mjs', import.meta.url).pathname
const TEMPLATE = new URL('../../assets/template.html', import.meta.url)

const CONFIG = '{"type":"config","name":"Speed up","metricName":"total_ms","metricUnit":"ms","bestDirection":"lower"}\n'
const RUN = n => `{"run":${n},"commit":"abc${n}","metric":${100 - n},"metrics":{},"status":"keep","description":"run ${n}","timestamp":${n},"segment":0,"confidence":null}\n`

let dir, logPath, child, port

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'autoresearch-server-test-'))
  logPath = join(dir, 'log.jsonl')
  writeFileSync(join(dir, 'index.html'), '<title>dashboard</title>')
  writeFileSync(logPath, CONFIG + RUN(1))
  child = spawn(process.execPath, [SERVER, join(dir, 'index.html'), logPath], { stdio: ['ignore', 'pipe', 'inherit'] })
  port = await new Promise((resolve, reject) => {
    let out = ''
    child.stdout.on('data', chunk => {
      out += chunk
      const match = /^listening (\d+)$/m.exec(out)
      if (match) resolve(Number(match[1]))
    })
    child.on('exit', code => reject(new Error(`server exited with ${code}`)))
  })
})

after(() => {
  child?.kill()
  rmSync(dir, { recursive: true, force: true })
})

function get(path, { host = `127.0.0.1:${port}`, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host } }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('the template has one title and one logo placeholder and no remote resources', () => {
  const template = readFileSync(TEMPLATE, 'utf8')
  assert.equal(template.split('__AUTORESEARCH_TITLE__').length, 2)
  assert.equal(template.split('__AUTORESEARCH_LOGO__').length, 2)
  assert.match(template, /<title>__AUTORESEARCH_TITLE__<\/title>/)
  assert.doesNotMatch(template, /<(script|link|img)[^>]+(src|href)=["']?https?:/i)
  assert.match(template, /fetch\('autoresearch\.jsonl'/)
  assert.match(template, /new EventSource\('\/events'\)/)
})

test('it binds 127.0.0.1 and serves the dashboard and the log', async () => {
  const page = await get('/')
  assert.equal(page.status, 200)
  assert.equal(page.type, 'text/html; charset=utf-8')
  assert.equal(page.body, '<title>dashboard</title>')

  const log = await get('/autoresearch.jsonl')
  assert.equal(log.status, 200)
  assert.equal(log.body, readFileSync(logPath, 'utf8'))
})

test('it serves nothing else', async () => {
  for (const path of ['/index.html', '/log.jsonl', '/../log.jsonl', '/%2e%2e/log.jsonl', '/etc/passwd']) {
    assert.equal((await get(path)).status, 404, path)
  }
  assert.equal((await get('/', { method: 'POST' })).status, 405)
})

test('it refuses other Host names (DNS rebinding)', async () => {
  assert.equal((await get('/autoresearch.jsonl', { host: 'evil.example' })).status, 403)
  assert.equal((await get('/autoresearch.jsonl', { host: `evil.example:${port}` })).status, 403)
  assert.equal((await get('/autoresearch.jsonl', { host: `localhost:${port}` })).status, 200)
})

test('appending to the log sends jsonl-updated to /events', async () => {
  const event = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/events' }, res => {
      assert.equal(res.headers['content-type'], 'text/event-stream')
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => {
        text += chunk
        if (text.includes('retry: 1000') && !text.includes('event:')) appendFileSync(logPath, RUN(2))
        const match = /event: (\S+)\ndata: (\d+)\n\n/.exec(text)
        if (match) {
          req.destroy()
          resolve(match[1])
        }
      })
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(event, 'jsonl-updated')
  assert.match((await get('/autoresearch.jsonl')).body, /"run":2/)
})
