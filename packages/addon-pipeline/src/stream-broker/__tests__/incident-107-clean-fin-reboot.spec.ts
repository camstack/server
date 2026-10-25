import * as net from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IEventBus, IScopedLogger, StreamSource } from '@camstack/types'
import { StreamBroker } from '../stream-broker/stream-broker'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager'
import { DEFAULT_PREBUFFER_SEC } from '../prebuffer'

/**
 * End-to-end regression for the 2026-08-12 baichuan/Carol incident.
 *
 * INCIDENT: camera 107 ("Camera camera Carol", 192.168.60.226) rebooted.
 * The reboot dropped its rfc4571 loopback socket with a CLEAN FIN (not an
 * error/RST). The broker's status stayed latched at 'streaming' — a PHANTOM
 * state: 'streaming' means "loopback TCP is open" (set by `onPlaying` the
 * instant the socket connects; rfc4571 has no PLAY phase), NOT "media flowing".
 * The clean FIN routed through `onTeardown` → `destroyRfc4571Reader()`, which
 * cancelled both watchdogs and returned WITHOUT setting `_status`, WITHOUT
 * `scheduleReconnect()`, WITHOUT `notifySourceRefresh()`. So the broker sat
 * "streaming" forever with zero traffic.
 *
 * CONFIRMED LIVE: restarting the stream-broker RUNNER recovered 592 instantly
 * (fresh process, phantom in-memory state gone). Camera reboot +
 * `assignProfile` reassign + provider restart did NOT — none of those restart
 * the broker runner. So the wedge was purely in-memory broker state, and only
 * a code fix that makes the broker self-heal (no runner restart) prevents it.
 *
 * This test drives the EXACT sequence through the real `Rfc4571Reader` + broker
 * state machine over a loopback TCP server (a fake camera socket — no live
 * camera) and proves the fix self-heals without any external restart.
 *
 * With the fix reverted this test reproduces the live symptom: status latched
 * at 'streaming' after the clean FIN, no reconnect scheduled (the waitFor for a
 * non-'streaming' status times out and the test fails).
 */

function createMockLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
  return logger
}

function noopBus(): IEventBus {
  const bus: IEventBus = {
    emit: () => {},
    subscribe: () => () => {},
    getRecent: () => [],
  }
  return bus
}

const SDP = ['v=0', 'm=video 0 RTP/AVP 96', 'a=rtpmap:96 H264/90000'].join('\r\n')

function rfc4571Source(port: number): StreamSource {
  return {
    type: 'rfc4571',
    url: `tcp://127.0.0.1:${port}`,
    videoCodec: 'h264',
    metadata: { sdp: SDP },
  }
}

function pushRtpSource(): StreamSource {
  return { type: 'push-rtp', url: '', videoCodec: 'h264' }
}

function framed(rtp: Buffer): Buffer {
  const len = Buffer.alloc(2)
  len.writeUInt16BE(rtp.length, 0)
  return Buffer.concat([len, rtp])
}

function videoRtp(seq: number): Buffer {
  const h = Buffer.alloc(12)
  h[0] = 0x80
  h[1] = 96
  h.writeUInt16BE(seq & 0xffff, 2)
  h.writeUInt32BE((seq * 3000) >>> 0, 4)
  h.writeUInt32BE(0x11223344, 8)
  return Buffer.concat([h, Buffer.from([0x61, 0x00, 0x00, 0x01])])
}

interface Loopback {
  readonly server: net.Server
  readonly port: number
  readonly connections: net.Socket[]
}

async function startLoopback(): Promise<Loopback> {
  const connections: net.Socket[] = []
  const server = net.createServer((sock) => {
    connections.push(sock)
    sock.on('data', () => {})
    sock.on('error', () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { server, port, connections }
}

async function waitFor(pred: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now()
  while (!pred()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor: condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('incident 2026-08-12 — camera 107 clean-FIN reboot', () => {
  const brokers: StreamBroker[] = []
  const loopbacks: Loopback[] = []
  const managers: StreamBrokerManager[] = []

  afterEach(async () => {
    for (const b of brokers) await b.stop().catch(() => {})
    for (const m of managers) await m.destroyAll().catch(() => {})
    // `broker.stop()` does not tear the rfc4571 reader down, so its socket can
    // linger — destroy every accepted connection so `server.close()` returns
    // instead of blocking on an open socket (and timing the hook out).
    for (const lb of loopbacks) {
      for (const c of lb.connections) c.destroy()
      await new Promise<void>((resolve) => lb.server.close(() => resolve()))
    }
    brokers.length = 0
    loopbacks.length = 0
    managers.length = 0
  })

  it('recovers a clean-FIN teardown without a broker restart, and self-heals a dead re-dial', async () => {
    const logger = createMockLogger()
    const refreshSpy = vi.fn()
    const broker = new StreamBroker('107/main', logger)
    // `rfc4571` is a lazy-dial source. The incident is about a camera that WAS
    // dialed with nobody watching, which is the prebuffer hold's job — stated
    // explicitly now, because a bare broker no longer starts warm (D381).
    broker.setPrebuffer({ enabled: true, seconds: DEFAULT_PREBUFFER_SEC })
    broker.setRequestSourceRefresh(refreshSpy)
    brokers.push(broker)

    const lb = await startLoopback()
    loopbacks.push(lb)

    // ── Phase 1: dial → socket connects → onPlaying → phantom 'streaming' ──
    await broker.start(rfc4571Source(lb.port))
    await waitFor(() => broker.getStats().status === 'streaming')
    await waitFor(() => lb.connections.length === 1)
    expect(broker.getStats().status).toBe('streaming') // phantom: TCP open, not media

    // Fix 1: the activity watchdog is armed at DIAL time — a connection that
    // delivers nothing is now detectable.
    expect(broker.getRtpActivityWatchdogStatus().armed).toBe(true)

    // ── Phase 2: media flows briefly, then a CLEAN CLOSE (FIN) ──
    lb.connections[0]!.write(framed(videoRtp(1)))
    await waitFor(() => broker.getFirstVideoWatchdogStatus().videoRtpSeen >= 1)

    refreshSpy.mockClear()
    // The reboot signature: server half-closes with a FIN (`end()`), NOT an
    // error/RST. On the client this is `socket 'close'` with the reader's own
    // `destroyed === false` — routed through `onTeardown`.
    lb.connections[0]!.end()

    // ── Phase 3: self-heal WITHOUT any external restart ──
    await waitFor(() => broker.getStats().status !== 'streaming')
    expect(broker.getStats().status).not.toBe('streaming') // no phantom latch
    await waitFor(() => refreshSpy.mock.calls.length >= 1)
    expect(refreshSpy).toHaveBeenCalled() // notifySourceRefresh (rfc4571)
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/Reconnecting/),
      expect.anything(),
    ) // scheduleReconnect

    // ── Phase 3b: the re-dial connects but delivers ZERO bytes (the live
    // '~8-15s loop': connects, no video RTP) — the dial-time watchdog detects
    // it and forces ANOTHER redial rather than sitting silent. ──
    await waitFor(() => lb.connections.length >= 2, 6_000)
    await waitFor(() => broker.getStats().status === 'streaming', 6_000)
    expect(broker.getRtpActivityWatchdogStatus().armed).toBe(true) // armed on re-dial
    // Send nothing on connection 2. Within the watchdog window a fresh refresh
    // fires (either the first-video or the activity watchdog, both gated to
    // rfc4571) — the broker keeps trying instead of latching a dead stream.
    await waitFor(() => refreshSpy.mock.calls.length >= 2, 15_000)
    expect(refreshSpy.mock.calls.length).toBeGreaterThanOrEqual(2)

    await broker.stop()

    // ── Phase 4: manager backstop — the level-triggered health sweep redials a
    // broker still reporting 'streaming' with no traffic (the exact phantom). ──
    const sweepLogger = createMockLogger()
    const manager = new StreamBrokerManager(sweepLogger)
    manager.setEventBus(noopBus())
    managers.push(manager)
    const phantom = new StreamBroker('107/main', sweepLogger)
    brokers.push(phantom)
    const redial = vi.spyOn(phantom, 'redial').mockImplementation(() => {})
    await phantom.start(pushRtpSource())
    expect(phantom.getStats().status).toBe('streaming')
    expect(phantom.getLastPacketAt()).toBe(0)
    manager.runStreamHealthSweepForTest('107/main', phantom)
    expect(redial).toHaveBeenCalledTimes(1)

    // ── Phase 5: reader-identity guard — a late close from a SUPERSEDED reader
    // must not tear down the current one. ──
    const idLogger = createMockLogger()
    const idRefresh = vi.fn()
    const idBroker = new StreamBroker('107/sub', idLogger)
    // Same reason as the broker above: the hold is what dials this lazy source.
    idBroker.setPrebuffer({ enabled: true, seconds: DEFAULT_PREBUFFER_SEC })
    idBroker.setRequestSourceRefresh(idRefresh)
    brokers.push(idBroker)
    const lb2 = await startLoopback()
    loopbacks.push(lb2)

    await idBroker.start(rfc4571Source(lb2.port))
    await waitFor(() => idBroker.getStats().status === 'streaming')
    await waitFor(() => lb2.connections.length === 1)
    // A video packet clears the dial rate-limit so the next start() actually
    // supersedes reader A with reader B (A orphaned, its socket still open).
    lb2.connections[0]!.write(framed(videoRtp(1)))
    await waitFor(() => idBroker.getFirstVideoWatchdogStatus().videoRtpSeen >= 1)
    await idBroker.start(rfc4571Source(lb2.port))
    await waitFor(() => lb2.connections.length === 2)
    await waitFor(() => idBroker.getStats().status === 'streaming')

    idRefresh.mockClear()
    lb2.connections[0]!.destroy() // late close from the superseded socket A
    await new Promise((r) => setTimeout(r, 150))
    expect(idBroker.getStats().status).toBe('streaming') // B untouched
    expect(idRefresh).not.toHaveBeenCalled()
    expect(lb2.connections[1]!.destroyed).toBe(false) // B still connected
  }, 30_000)
})
