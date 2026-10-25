import { afterEach, describe, expect, it } from 'vitest'
import { createConnection } from 'node:net'
import {
  applyLanHttp,
  closeLanHttp,
  registerLanHttpHandler,
  allFamiliesListenHost,
} from '../lan-http-bind.js'

afterEach(async () => {
  await closeLanHttp()
  registerLanHttpHandler(null)
})

function httpGet(host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host, port }, () => {
      sock.write(`GET /health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
    })
    let body = ''
    sock.on('data', (chunk) => {
      body += chunk.toString()
    })
    sock.on('end', () => {
      resolve(Number.parseInt(body.split(' ')[1] ?? '', 10))
    })
    sock.on('error', reject)
    sock.setTimeout(2000, () => reject(new Error(`timeout connecting to ${host}`)))
  })
}

describe('LAN HTTP bind', () => {
  it('forwards WebSocket upgrades to the same handler graph as HTTPS', async () => {
    let upgradedPath: string | null = null
    registerLanHttpHandler({
      onRequest: (_req, res) => {
        res.writeHead(200)
        res.end('ok')
      },
      onUpgrade: (req, socket) => {
        upgradedPath = (req.url ?? '').split('?')[0] ?? null
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
        )
        socket.end()
      },
    })
    const state = await applyLanHttp({ enabled: true, port: 0, host: '127.0.0.1' })
    expect(state.listening).toBe(true)
    expect(state.port).toBeGreaterThan(0)

    await new Promise<void>((resolve, reject) => {
      const sock = createConnection({ host: '127.0.0.1', port: state.port }, () => {
        sock.write(
          'GET /trpc HTTP/1.1\r\n' +
            'Host: 127.0.0.1\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
            'Sec-WebSocket-Version: 13\r\n' +
            '\r\n',
        )
      })
      sock.on('data', () => {
        sock.end()
        resolve()
      })
      sock.on('error', reject)
      sock.setTimeout(2000, () => reject(new Error('upgrade timed out')))
    })

    expect(upgradedPath).toBe('/trpc')
  })

  it('maps 0.0.0.0 to dual-stack ::', () => {
    expect(allFamiliesListenHost('0.0.0.0')).toEqual({ host: '::', ipv6Only: false })
    expect(allFamiliesListenHost('::')).toEqual({ host: '::', ipv6Only: false })
    expect(allFamiliesListenHost('127.0.0.1')).toEqual({ host: '127.0.0.1', ipv6Only: false })
  })

  it('accepts IPv4 and IPv6 clients when asked to bind 0.0.0.0', async () => {
    registerLanHttpHandler({
      onRequest: (_req, res) => {
        res.writeHead(200)
        res.end('ok')
      },
      onUpgrade: () => undefined,
    })
    const state = await applyLanHttp({ enabled: true, port: 0, host: '0.0.0.0' })
    expect(state.listening).toBe(true)
    expect(await httpGet('127.0.0.1', state.port)).toBe(200)
    expect(await httpGet('::1', state.port)).toBe(200)
  })
})
