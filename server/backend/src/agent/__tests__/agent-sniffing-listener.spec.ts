import * as http from 'node:http'
import * as net from 'node:net'
import * as https from 'node:https'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureTlsCert, regenerateCertificate } from '@camstack/system'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type SniffingListener, startSniffingListener } from '../agent-sniffing-listener.js'

let dir: string
let httpServer: http.Server
let listener: SniffingListener | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sniff-'))
  httpServer = http.createServer((req, res) => {
    res.end(`ok ${req.socket.remoteAddress ?? ''}`.trim())
  })
})
afterEach(async () => {
  await listener?.close()
  listener = null
  httpServer.close()
  rmSync(dir, { recursive: true, force: true })
})

async function material() {
  await ensureTlsCert(dir)
  return {
    keyPem: readFileSync(join(dir, 'tls', 'camstack.key'), 'utf8'),
    certPem: readFileSync(join(dir, 'tls', 'camstack.crt'), 'utf8'),
    caPem: readFileSync(join(dir, 'tls', 'camstack-ca.crt'), 'utf8'),
  }
}

function plainGet(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        let body = ''
        res.on('data', (c: Buffer) => {
          body += c.toString()
        })
        res.on('end', () => resolve(body))
      })
      .on('error', reject)
  })
}

function tlsGet(port: number, ca: string): Promise<{ body: string; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        host: '127.0.0.1',
        port,
        path: '/',
        ca,
        // The leaf names the machine's addresses; this test pins the CA, not the name.
        checkServerIdentity: () => undefined,
        // A fresh connection each time: the default agent keeps sockets alive and reuses them.
        agent: false,
      },
      (res) => {
        // Read the peer certificate now: after 'end' the socket may already be gone.
        const tlsSocket = res.socket
        const fingerprint = (
          tlsSocket as unknown as { getPeerCertificate(): { fingerprint256: string } }
        ).getPeerCertificate().fingerprint256
        let body = ''
        res.on('data', (c: Buffer) => {
          body += c.toString()
        })
        res.on('end', () => resolve({ body, fingerprint }))
      },
    )
    req.on('error', reject)
  })
}

describe('one port, two protocols (first-byte sniffing)', () => {
  it('serves plain HTTP AND TLS on the SAME port', async () => {
    const m = await material()
    listener = await startSniffingListener({ httpServer, port: 0, host: '127.0.0.1', material: m })
    expect(await plainGet(listener.port)).toMatch(/^ok /)
    const secure = await tlsGet(listener.port, m.caPem)
    expect(secure.body).toMatch(/^ok /)
    // The HTTP handler sees the real peer through the decrypted socket.
    expect(secure.body).toContain('127.0.0.1')
  })

  it('a TLS client with no certificate installed is closed (and counted); plain HTTP still works', async () => {
    const m = await material()
    let refused = 0
    listener = await startSniffingListener({
      httpServer,
      port: 0,
      host: '127.0.0.1',
      material: null,
      onTlsRefused: () => {
        refused += 1
      },
    })
    await expect(tlsGet(listener.port, m.caPem)).rejects.toThrow()
    expect(refused).toBe(1)
    expect(listener.tlsRefusedCount()).toBe(1)
    expect(await plainGet(listener.port)).toMatch(/^ok /)
    // Installing a certificate later turns TLS on without a restart.
    listener.setMaterial({ keyPem: m.keyPem, certPem: m.certPem })
    expect((await tlsGet(listener.port, m.caPem)).body).toMatch(/^ok /)
  })

  it('hot-swaps the certificate: a new handshake sees the new leaf, no restart', async () => {
    const m = await material()
    listener = await startSniffingListener({ httpServer, port: 0, host: '127.0.0.1', material: m })
    const before = await tlsGet(listener.port, m.caPem)
    await regenerateCertificate(dir, {})
    const next = {
      keyPem: readFileSync(join(dir, 'tls', 'camstack.key'), 'utf8'),
      certPem: readFileSync(join(dir, 'tls', 'camstack.crt'), 'utf8'),
    }
    listener.setMaterial(next)
    const after = await tlsGet(listener.port, m.caPem)
    expect(after.fingerprint).not.toBe(before.fingerprint)
  })

  it('SECURITY: a TLS handshake that stalls is destroyed (and logged), not held for ever', async () => {
    const m = await material()
    const warnings: string[] = []
    listener = await startSniffingListener({
      httpServer,
      port: 0,
      host: '127.0.0.1',
      material: m,
      handshakeTimeoutMs: 300,
      log: { warn: (msg) => void warnings.push(msg), error: () => undefined },
    })
    const closed = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: listener?.port ?? 0 }, () => {
        // The first byte of a TLS handshake record, then silence.
        socket.write(Buffer.from([0x16]))
      })
      socket.on('close', () => resolve(true))
      socket.on('error', () => undefined)
      setTimeout(() => resolve(false), 3_000)
    })
    expect(closed).toBe(true)
    expect(warnings.some((w) => w.includes('handshake did not finish'))).toBe(true)
  })

  it('SECURITY: unusable material neither throws nor takes the API down: plain HTTP and the previous certificate keep serving', async () => {
    const m = await material()
    const errors: string[] = []
    listener = await startSniffingListener({
      httpServer,
      port: 0,
      host: '127.0.0.1',
      material: { keyPem: 'not a key', certPem: 'not a cert' },
      log: { warn: () => undefined, error: (msg) => void errors.push(msg) },
    })
    expect(errors).toHaveLength(1)
    expect(await plainGet(listener.port)).toMatch(/^ok /)
    await expect(tlsGet(listener.port, m.caPem)).rejects.toThrow()
    expect(listener.setMaterial({ keyPem: m.keyPem, certPem: m.certPem })).toBe(true)
    const before = await tlsGet(listener.port, m.caPem)
    // A bad swap is refused and the good certificate keeps serving.
    expect(listener.setMaterial({ keyPem: 'x', certPem: 'y' })).toBe(false)
    const after = await tlsGet(listener.port, m.caPem)
    expect(after.fingerprint).toBe(before.fingerprint)
  })

  it('stalled-handshake warnings are rate limited: a burst logs once, not once per connection', async () => {
    const m = await material()
    const warnings: string[] = []
    listener = await startSniffingListener({
      httpServer,
      port: 0,
      host: '127.0.0.1',
      material: m,
      handshakeTimeoutMs: 150,
      log: { warn: (msg) => void warnings.push(msg), error: () => undefined },
    })
    const port = listener.port
    await Promise.all(
      [1, 2, 3, 4].map(
        () =>
          new Promise<void>((resolve) => {
            const socket = net.connect({ host: '127.0.0.1', port }, () =>
              socket.write(Buffer.from([0x16])),
            )
            socket.on('close', () => resolve())
            socket.on('error', () => undefined)
          }),
      ),
    )
    expect(warnings.filter((w) => w.includes('handshake did not finish'))).toHaveLength(1)
  })

  it('shutdown ends idle keep-alive connections instead of waiting on them for ever', async () => {
    const m = await material()
    listener = await startSniffingListener({ httpServer, port: 0, host: '127.0.0.1', material: m })
    const idle = net.connect({ host: '127.0.0.1', port: listener.port })
    await new Promise<void>((resolve) => idle.once('connect', () => resolve()))
    idle.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n')
    await new Promise((r) => idle.once('data', r))
    const closed = new Promise<boolean>((resolve) => {
      idle.once('close', () => resolve(true))
      setTimeout(() => resolve(false), 6_000)
    })
    const startedAt = Date.now()
    await listener.close()
    listener = null
    expect(await closed).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  }, 15_000)
})
