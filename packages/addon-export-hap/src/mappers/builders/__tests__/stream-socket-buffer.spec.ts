/**
 * The loopback receive buffer, and the counter that proves whether it was
 * enough.
 *
 * Written first, against the measurement that forced it: on 101/high
 * (3840x2160 pass-through) a session forwarded 93 video packets in 30.8 s while
 * the AUDIO leg of the SAME ffmpeg forwarded 1497 with zero loss. A 4K IDR is
 * on the order of a megabyte, which at `pkt_size=1378` is ~750 datagrams
 * delivered as one burst — into a socket whose SO_RCVBUF nobody had ever set,
 * i.e. `net.core.rmem_default`, 212 992 bytes on this hub.
 *
 * These are the two things the experiment needs to be decidable from a log
 * line: what the kernel actually GRANTED (it may clamp at
 * `net.core.rmem_max`), and how many datagrams it threw away.
 */
import { describe, expect, it } from 'vitest'

import {
  applyReceiveBuffer,
  AUDIO_LOOPBACK_RCVBUF_BYTES,
  KEYFRAME_BURST_FLOOR_BYTES,
  mergeDropSample,
  parseUdpSocketDrops,
  type ReceiveBufferSocket,
  VIDEO_LOOPBACK_RCVBUF_BYTES,
} from '../stream-socket-buffer.js'

/**
 * A socket that behaves like Linux: it accepts any request, clamps it at a
 * ceiling, and reports back DOUBLE what it stored (the kernel's own
 * bookkeeping overhead allowance). Both behaviours matter — a naive
 * `effective === requested` check would call every honoured request clamped.
 */
function linuxSocket(ceilingBytes: number): ReceiveBufferSocket {
  let stored = 212_992
  return {
    setRecvBufferSize(size: number): void {
      stored = Math.min(size, ceilingBytes)
    },
    getRecvBufferSize(): number {
      return stored * 2
    },
  }
}

describe('the loopback receive-buffer sizes', () => {
  it('asks for enough video buffer to hold a 4K key-frame burst', () => {
    // ~750 datagrams × 1378 B ≈ 1.03 MB for ONE IDR, and the burst can overlap
    // the frames around it. The floor is what the log line judges against.
    expect(VIDEO_LOOPBACK_RCVBUF_BYTES).toBeGreaterThanOrEqual(KEYFRAME_BURST_FLOOR_BYTES)
  })

  it('asks for less on audio, which never bursts', () => {
    expect(AUDIO_LOOPBACK_RCVBUF_BYTES).toBeLessThan(VIDEO_LOOPBACK_RCVBUF_BYTES)
  })
})

describe('applyReceiveBuffer', () => {
  it('reports the size the kernel GRANTED, not the one we asked for', () => {
    const socket = linuxSocket(16 * 1024 * 1024)
    const outcome = applyReceiveBuffer(socket, VIDEO_LOOPBACK_RCVBUF_BYTES)
    expect(outcome.requestedBytes).toBe(VIDEO_LOOPBACK_RCVBUF_BYTES)
    expect(outcome.effectiveBytes).toBe(VIDEO_LOOPBACK_RCVBUF_BYTES * 2)
    expect(outcome.clamped).toBe(false)
    expect(outcome.error).toBeNull()
  })

  it('says CLAMPED when net.core.rmem_max is below the request', () => {
    // The whole experiment turns on this: a host with the stock 212 992-byte
    // rmem_max grants nothing useful, and the fix would look applied while
    // changing nothing. That needs a sysctl on the HOST, not a code change.
    const socket = linuxSocket(212_992)
    const outcome = applyReceiveBuffer(socket, VIDEO_LOOPBACK_RCVBUF_BYTES)
    expect(outcome.clamped).toBe(true)
    expect(outcome.effectiveBytes).toBe(212_992 * 2)
    expect(outcome.sufficientForKeyframeBurst).toBe(false)
  })

  it('judges sufficiency against the key-frame burst floor', () => {
    const outcome = applyReceiveBuffer(linuxSocket(16 * 1024 * 1024), VIDEO_LOOPBACK_RCVBUF_BYTES)
    expect(outcome.sufficientForKeyframeBurst).toBe(true)
  })

  it('never throws when the platform refuses the option', () => {
    const socket: ReceiveBufferSocket = {
      setRecvBufferSize(): void {
        throw new Error('ENOPROTOOPT')
      },
      getRecvBufferSize(): number {
        throw new Error('ENOPROTOOPT')
      },
    }
    const outcome = applyReceiveBuffer(socket, VIDEO_LOOPBACK_RCVBUF_BYTES)
    expect(outcome.error).toContain('ENOPROTOOPT')
    expect(outcome.effectiveBytes).toBeNull()
    // Unknown is NOT reported as sufficient — silence must not read as "fine".
    expect(outcome.sufficientForKeyframeBurst).toBe(false)
  })
})

/**
 * `/proc/net/udp`, trimmed to three rows. The last column is `drops` — the
 * per-socket count of datagrams the kernel discarded because the receive
 * buffer was full. That is the ONLY place this loss is visible: a datagram
 * dropped here never reaches a `message` handler, so from userspace it looks
 * exactly like a packet ffmpeg never sent.
 */
const PROC_NET_UDP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops
  123: 0100007F:9C41 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 501234 2 0000000000000000 4211
  124: 0100007F:9C42 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 501235 2 0000000000000000 0
  125: 00000000:0035 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 4711 2 0000000000000000 17`

describe('mergeDropSample', () => {
  /**
   * Found on the FIRST live session that proved the buffer fix
   * (`12308100-7dbe-4ad1-b277-1f046ba54ec2`, 2026-08-07): the summary carried
   * `videoLoopKernelDrops=null` even though the socket had been readable
   * throughout.
   *
   * The teardown order is the cause and it is not going to change: on a
   * controller `stop`, `killFfmpeg` sends SIGTERM and the sockets are closed
   * SYNCHRONOUSLY, while `logSessionSummary` runs later from ffmpeg's `exit`
   * handler. By then the ports are gone from `/proc/net/udp`, so the
   * summary-time resample looked up nothing and clobbered a perfectly good
   * heartbeat sample.
   *
   * "The socket is gone so I can no longer look" must never erase "I looked and
   * it was 0". That erasure is precisely the silence-reads-as-fine failure this
   * counter exists to prevent, in the counter itself.
   */
  it('keeps a known reading when the socket can no longer be found', () => {
    expect(mergeDropSample(0, null)).toBe(0)
    expect(mergeDropSample(4211, null)).toBe(4211)
  })

  it('takes a fresh reading over a stale one', () => {
    expect(mergeDropSample(0, 17)).toBe(17)
    expect(mergeDropSample(17, 0)).toBe(0)
  })

  it('stays null while nothing has ever been readable', () => {
    expect(mergeDropSample(null, null)).toBeNull()
    expect(mergeDropSample(null, 0)).toBe(0)
  })
})

describe('parseUdpSocketDrops', () => {
  it('finds the drop count for a port, matching the HEX local address', () => {
    // 0x9C41 = 40001.
    expect(parseUdpSocketDrops(PROC_NET_UDP, 40_001)).toBe(4211)
    expect(parseUdpSocketDrops(PROC_NET_UDP, 40_002)).toBe(0)
  })

  it('distinguishes "no drops" from "socket not found"', () => {
    // 0 and null mean opposite things and must never collapse: 0 is evidence,
    // null is the absence of it.
    expect(parseUdpSocketDrops(PROC_NET_UDP, 40_002)).toBe(0)
    expect(parseUdpSocketDrops(PROC_NET_UDP, 65_000)).toBeNull()
  })

  it('returns null rather than guessing on a table it cannot parse', () => {
    expect(parseUdpSocketDrops('', 40_001)).toBeNull()
    expect(parseUdpSocketDrops('nonsense\nmore nonsense', 40_001)).toBeNull()
  })
})
