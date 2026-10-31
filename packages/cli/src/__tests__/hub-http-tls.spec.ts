import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as https from 'node:https'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hubRequest } from '../http/hub-http.js'

let dir: string
let server: https.Server
let url: string
let pem: string

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tls-'))
  const key = path.join(dir, 'key.pem')
  const crt = path.join(dir, 'crt.pem')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      crt,
      '-days',
      '2',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  )
  pem = fs.readFileSync(crt, 'utf8')
  server = https.createServer({ key: fs.readFileSync(key), cert: pem }, (_req, res) => {
    res.end('{"ok":true}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no listening port')
  const port = addr.port
  url = `https://127.0.0.1:${port}/health`
  fs.mkdirSync(path.join(dir, 'pins'))
  fs.mkdirSync(path.join(dir, 'empty'))
  fs.writeFileSync(path.join(dir, 'pins', `127.0.0.1_${port}.ca.pem`), pem)
})

afterAll(() => {
  server.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('hubRequest trusts only the pinned hub CA', () => {
  it('refuses a self-signed hub that is not pinned, naming the fix', async () => {
    await expect(hubRequest(url, { sessionDir: path.join(dir, 'empty'), env: {} })).rejects.toThrow(
      /TLS verification .* failed .*never switched off/s,
    )
  })

  it('accepts the same hub once its PEM is pinned', async () => {
    const res = await hubRequest(url, { sessionDir: path.join(dir, 'pins'), env: {} })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})
