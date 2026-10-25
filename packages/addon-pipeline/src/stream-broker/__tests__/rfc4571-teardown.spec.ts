import * as net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IScopedLogger, StreamSource } from '@camstack/types'
import { StreamBroker } from '../stream-broker/stream-broker'
import { DEFAULT_PREBUFFER_SEC } from '../prebuffer'

/**
 * rfc4571 teardown-path regression suite (tonight's baichuan/Carol wedge).
 *
 * When a Reolink camera reboots it drops the loopback TCP socket with a clean
 * FIN. That close arrives on the rfc4571 reader's `socket.on('close')` with
 * `destroyed === false` (the broker never asked the reader to die), so it must
 * be treated as a FAILURE EDGE: the broker leaves `status: 'streaming'`, asks
 * the publisher to re-materialize the source, and schedules a redial. Before
 * the fix the close routed through `destroyRfc4571Reader()` and returned
 * WITHOUT touching `_status` / `scheduleReconnect` / `notifySourceRefresh`, so
 * the broker latched a phantom `streaming` state forever.
 *
 * These are real-socket integration tests: a loopback TCP server stands in for
 * the Reolink lib's `createRfc4571TcpServer`, and closing its accepted socket
 * drives the exact `close` event the camera reboot produced.
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

const SDP = ['v=0', 'm=video 0 RTP/AVP 96', 'a=rtpmap:96 H264/90000'].join('\r\n')

function rfc4571Source(port: number): StreamSource {
  return {
    type: 'rfc4571',
    url: `tcp://127.0.0.1:${port}`,
    videoCodec: 'h264',
    metadata: { sdp: SDP },
  }
}

/** RFC 4571 length-prefix a raw RTP packet for the wire. */
function framed(rtp: Buffer): Buffer {
  const len = Buffer.alloc(2)
  len.writeUInt16BE(rtp.length, 0)
  return Buffer.concat([len, rtp])
}

/** A video RTP packet on payload type 96 (matches the SDP video track). */
function videoRtp(seq: number): Buffer {
  const h = Buffer.alloc(12)
  h[0] = 0x80
  h[1] = 96 // PT 96, marker off
  h.writeUInt16BE(seq & 0xffff, 2)
  h.writeUInt32BE((seq * 3000) >>> 0, 4)
  h.writeUInt32BE(0x11223344, 8)
  // A single-NAL-unit-ish payload; the depacketizer tolerates it.
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
    // Swallow the auth line / any client bytes; errors on abrupt close are fine.
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

describe('StreamBroker rfc4571 teardown = failure edge', () => {
  let broker: StreamBroker
  let logger: IScopedLogger
  let lb: Loopback
  let refreshSpy: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    logger = createMockLogger()
    broker = new StreamBroker('592/main', logger)
    // `rfc4571` is a lazy-dial source: with nothing holding it, `start()`
    // registers idle and defers the dial, and none of the teardown edges below
    // ever happen. The prebuffer hold is what keeps this camera dialed with no
    // consumer attached — and it is now stated here rather than inherited from
    // a default, because a bare broker no longer starts warm (D381).
    broker.setPrebuffer({ enabled: true, seconds: DEFAULT_PREBUFFER_SEC })
    refreshSpy = vi.fn()
    broker.setRequestSourceRefresh(refreshSpy)
    lb = await startLoopback()
  })

  afterEach(async () => {
    await broker.stop()
    for (const c of lb.connections) c.destroy()
    await new Promise<void>((resolve) => lb.server.close(() => resolve()))
  })

  it('arms the source-RTP activity watchdog at DIAL time (before any packet)', async () => {
    await broker.start(rfc4571Source(lb.port))
    // No RTP has flowed yet — a connection that delivers nothing must still be
    // detectable. The watchdog is armed synchronously at dial.
    expect(broker.getRtpActivityWatchdogStatus().armed).toBe(true)
  })

  it('treats a source-side close (destroyed=false) as a failure edge — not phantom streaming', async () => {
    await broker.start(rfc4571Source(lb.port))
    await waitFor(() => broker.getStats().status === 'streaming')
    await waitFor(() => lb.connections.length === 1)

    refreshSpy.mockClear()
    // Camera reboot: server drops the accepted socket → client `close` with
    // destroyed === false.
    lb.connections[0]!.destroy()

    // The broker must LEAVE the phantom streaming state, ask the publisher to
    // refresh (rfc4571 loopback), and arm a redial.
    await waitFor(() => broker.getStats().status !== 'streaming')
    await waitFor(() => refreshSpy.mock.calls.length > 0)
    expect(broker.getStats().status).not.toBe('streaming')
    expect(refreshSpy).toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/Reconnecting/),
      expect.anything(),
    )
  })

  it('does NOT reconnect or refresh on a deliberate stop (manualStop guard)', async () => {
    await broker.start(rfc4571Source(lb.port))
    await waitFor(() => broker.getStats().status === 'streaming')
    await waitFor(() => lb.connections.length === 1)

    await broker.stop()
    refreshSpy.mockClear()
    const infoCallsBefore = vi.mocked(logger.info).mock.calls.length

    // stop() does not tear the rfc4571 reader down, so the lingering socket
    // still closes when the server goes away — the guard must swallow it.
    lb.connections[0]!.destroy()
    await new Promise((r) => setTimeout(r, 100))

    // The guard must swallow the close: the deliberate 'stopped' state is not
    // overwritten with 'error', and no publisher refresh is fired.
    expect(broker.getStats().status).toBe('stopped')
    expect(refreshSpy).not.toHaveBeenCalled()
    const reconnectLogged = vi
      .mocked(logger.info)
      .mock.calls.slice(infoCallsBefore)
      .some((c) => typeof c[0] === 'string' && /Reconnecting/.test(c[0]))
    expect(reconnectLogged).toBe(false)
  })

  it('resets videoRtpSeen to 0 on every dial (first-video watchdog stays alive across re-dials)', async () => {
    await broker.start(rfc4571Source(lb.port))
    await waitFor(() => broker.getStats().status === 'streaming')
    await waitFor(() => lb.connections.length === 1)

    // Deliver one video packet — videoRtpSeen becomes 1 and resets the dial gate.
    lb.connections[0]!.write(framed(videoRtp(1)))
    await waitFor(() => broker.getFirstVideoWatchdogStatus().videoRtpSeen >= 1)
    expect(broker.getFirstVideoWatchdogStatus().videoRtpSeen).toBeGreaterThan(0)

    // Camera reboot → failure edge → scheduled redial. Wait for the second
    // connection (the reconnect) to land.
    lb.connections[0]!.destroy()
    await waitFor(() => lb.connections.length === 2, 5_000)
    await waitFor(() => broker.getStats().status === 'streaming', 5_000)

    // No video on the fresh dial yet — the per-dial reset means the counter is
    // back to 0, so the first-video watchdog measures THIS connection.
    expect(broker.getFirstVideoWatchdogStatus().videoRtpSeen).toBe(0)
  })

  it('ignores a late close from a SUPERSEDED reader (reader-identity guard)', async () => {
    await broker.start(rfc4571Source(lb.port))
    await waitFor(() => broker.getStats().status === 'streaming')
    await waitFor(() => lb.connections.length === 1)

    // A video packet resets the dial rate-limit gate (nextDialAllowedAt = 0),
    // so a second immediate start() actually dials rather than deferring.
    lb.connections[0]!.write(framed(videoRtp(1)))
    await waitFor(() => broker.getFirstVideoWatchdogStatus().videoRtpSeen >= 1)

    // Supersede reader A with reader B (startRfc4571Reader does not destroy the
    // previous reader — A is orphaned but its socket stays open).
    await broker.start(rfc4571Source(lb.port))
    await waitFor(() => lb.connections.length === 2)
    await waitFor(() => broker.getStats().status === 'streaming')

    refreshSpy.mockClear()
    // A late close from the SUPERSEDED socket (connection A) must NOT tear down
    // the current reader (B).
    lb.connections[0]!.destroy()
    await new Promise((r) => setTimeout(r, 150))

    // B is untouched: still streaming, no refresh, connection B still open.
    expect(broker.getStats().status).toBe('streaming')
    expect(refreshSpy).not.toHaveBeenCalled()
    expect(lb.connections[1]!.destroyed).toBe(false)
  })
})
