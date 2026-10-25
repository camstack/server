/**
 * The manager's restream gate (D870), on the REAL RTSP server and provider.
 *
 * A camera whose restream tokens are held in an unreadable keychain has NO
 * external URL - nothing is listed, handed out or persisted for it - but the
 * broker's own consumers (recording, decode, snapshots, grid, egress) still ride
 * its restream through an ephemeral, loopback/local-network-only alias that is
 * never persisted. On recovery the external entry switches to the stored token
 * without tearing a broker or the alias down.
 */
import type { IScopedLogger } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as net from 'node:net'
import { isClusterLocalAddress, RtspListenServer } from '../rtsp/rtsp-listen-server.js'
import { RtspRestreamer } from '../rtsp/rtsp-restreamer.js'
import type { RtspRestreamProviderImpl } from '../rtsp/rtsp-restream-provider.js'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

interface Privates {
  rtspProvider: RtspRestreamProviderImpl
  rtspServer: RtspListenServer
  brokers: Map<string, unknown>
}

const open: StreamBrokerManager[] = []
afterEach(async () => {
  for (const m of open.splice(0)) {
    await (m as unknown as Privates).rtspServer.stop()
    const t = (m as unknown as { streamHealthTimer?: ReturnType<typeof setInterval> })
      .streamHealthTimer
    if (t) clearInterval(t)
  }
})

/** Camera 98 (open) and camera 99 (held), each with one published native stream. */
async function world() {
  const manager = new StreamBrokerManager(makeLogger())
  open.push(manager)
  const p = manager as unknown as Privates
  await manager.startRtspServer(0)
  const persisted: ReadonlyMap<string, string>[] = []
  p.rtspProvider.setTokenPersister((tokens) => persisted.push(new Map(tokens)))
  manager.loadPersistedTokens(
    new Map([
      ['98/native:main', 'stored-98'],
      ['98/low', 'stored-98-low'],
    ]),
  )
  manager.setRestreamGate((deviceId) => deviceId === 99)
  for (const deviceId of [98, 99]) {
    await manager.publishCameraStream({
      deviceId,
      camStreamId: 'native:main',
      kind: 'pull-rtsp',
      url: `rtsp://example/${deviceId}/main`,
    })
    await manager.assignProfile({ deviceId, profile: 'low', camStreamId: 'native:main' })
  }
  return { manager, p, persisted }
}

const codec = (deviceId: number) =>
  ({ deviceId, video: 'copy', audio: 'copy', profile: 'low' }) as const

describe('restream gate on the real RTSP server', () => {
  it('a held camera: NO external URL, nothing persisted - yet its internal consumers still get the restream', async () => {
    const { manager, p, persisted } = await world()
    const brokerId = '99/native:main'

    // external surface: none
    expect(p.rtspProvider.getEntry(brokerId)).toBeNull()
    expect(p.rtspProvider.getAllEntries().map((e) => e.brokerId)).not.toContain(brokerId)
    expect(p.rtspProvider.getEntriesForDevice(99)).toEqual([])
    // the open camera is untouched
    expect(p.rtspProvider.getEntry('98/native:main')?.url).toMatch(/\/stored-98$/)

    // internal surface: the recorder / decode path still resolves
    const source = await manager.getStreamWithCodec(codec(99))
    expect(source.url).toMatch(/^rtsp:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/)
    const alias = p.rtspProvider.getInternalEntry(brokerId)
    expect(alias).not.toBeNull()

    // the ephemeral token is never persisted, never listed
    p.rtspProvider.persistTokens()
    const last = persisted.at(-1)
    expect([...(last?.keys() ?? [])].some((id) => id.startsWith('99/'))).toBe(false)
    expect([...(last?.values() ?? [])]).not.toContain(alias?.url.split('/').pop())
    expect(p.rtspServer.getAllTokens().has(brokerId)).toBe(false)
  })

  it('recovery switches the external entry to the STORED token with no teardown; the alias stays', async () => {
    const { manager, p, persisted } = await world()
    const brokersBefore = [...p.brokers.values()]
    const aliasBefore = p.rtspProvider.getInternalEntry('99/native:main')?.url

    // the keychain is readable again: the gate opens, the stored tokens load
    let blocked = true
    manager.setRestreamGate((deviceId) => deviceId === 99 && blocked)
    blocked = false
    manager.loadPersistedTokens(
      new Map([
        ['98/native:main', 'stored-98'],
        ['98/low', 'stored-98-low'],
        ['99/native:main', 'stored-99'],
        ['99/low', 'stored-99-low'],
      ]),
    )
    manager.registerRestreamersForDevice(99)

    expect(p.rtspProvider.getEntry('99/native:main')?.url).toMatch(/\/stored-99$/)
    expect(p.rtspProvider.getEntry('99/low')?.url).toMatch(/\/stored-99-low$/)
    // nothing was retracted or recreated, and the internal consumers' URL is unchanged
    expect([...p.brokers.values()]).toEqual(brokersBefore)
    expect(p.rtspProvider.getInternalEntry('99/native:main')?.url).toBe(aliasBefore)
    // the stored token needed no new persist (it was already stored)
    expect(
      persisted.every((t) => ![...t.values()].some((v) => v === aliasBefore?.split('/').pop())),
    ).toBe(true)
  })

  it('DISARM: without the internal alias a held camera loses the data plane (getStreamWithCodec fails)', async () => {
    const { manager, p } = await world()
    p.rtspServer.unregisterRestreamer('99/native:main')
    await expect(manager.getStreamWithCodec(codec(99))).rejects.toThrow(/no broker restream/)
  })

  it('the alias answers loopback and the local network, never a public address', () => {
    expect(isClusterLocalAddress('127.0.0.1')).toBe(true)
    expect(isClusterLocalAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isClusterLocalAddress('::1')).toBe(true)
    expect(isClusterLocalAddress('192.168.1.40')).toBe(true)
    expect(isClusterLocalAddress('10.0.0.5')).toBe(true)
    expect(isClusterLocalAddress('172.20.0.2')).toBe(true)
    expect(isClusterLocalAddress('fd00::1')).toBe(true)
    expect(isClusterLocalAddress('8.8.8.8')).toBe(false)
    expect(isClusterLocalAddress('100.64.0.1')).toBe(true) // Tailscale / CGNAT
    expect(isClusterLocalAddress('100.127.255.254')).toBe(true)
    expect(isClusterLocalAddress('100.63.0.1')).toBe(false)
    expect(isClusterLocalAddress('100.128.0.1')).toBe(false)
    expect(isClusterLocalAddress('172.32.0.1')).toBe(false)
    expect(isClusterLocalAddress('2001:db8::1')).toBe(false)
    expect(isClusterLocalAddress(undefined)).toBe(false)
  })
})

describe('the internal alias over a REAL socket', () => {
  const dial = (port: number, token: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1')
      let data = ''
      socket.on('data', (c) => {
        data += c.toString('ascii')
        if (data.includes('\r\n\r\n')) {
          socket.destroy()
          resolve(data)
        }
      })
      socket.on('error', reject)
      socket.on('close', () => resolve(data))
      socket.write(`OPTIONS rtsp://127.0.0.1:${port}/${token} RTSP/1.0\r\nCSeq: 1\r\n\r\n`)
    })

  it('403 for a peer the policy refuses, a real answer for a local one, 404 for an unknown token', async () => {
    const server = new RtspListenServer()
    await server.start(0)
    try {
      const alias = server.registerInternalAlias(
        '7/native:main',
        new RtspRestreamer('7/native:main'),
      )
      // loopback peer: allowed (a real RTSP answer, not 403/404)
      const allowed = await dial(server.getPort(), alias)
      expect(allowed).not.toMatch(/^RTSP\/1\.0 (403|404)/)
      // a public peer (policy replaced so the loopback test socket stands in for it)
      server.setAliasPeerPolicy(() => false)
      expect(await dial(server.getPort(), alias)).toMatch(/^RTSP\/1\.0 403 Forbidden/)
      // an unknown token is a 404, as before
      expect(await dial(server.getPort(), 'ffffffffffffffffffffffffffffffff')).toMatch(
        /^RTSP\/1\.0 404/,
      )
    } finally {
      await server.stop()
    }
  })

  it('regenerating the external token rotates the alias too', async () => {
    const server = new RtspListenServer()
    const restreamer = new RtspRestreamer('7/native:main')
    server.registerRestreamer('7/native:main', restreamer)
    const aliasBefore = server.registerInternalAlias('7/native:main', restreamer)
    const tokenBefore = server.getToken('7/native:main')
    expect(server.regenerateToken('7/native:main')).not.toBe(tokenBefore)
    expect(server.getInternalToken('7/native:main')).not.toBe(aliasBefore)
  })
})
