/**
 * The kernel receive buffer on the loopback sockets ffmpeg writes RTP into —
 * and the counter that says whether it was enough.
 *
 * ## The measurement that forced this file
 *
 * On 101/high (3840x2160, pass-through) a HomeKit session logged:
 *
 *     durationMs=30820  videoPacketsForwarded=93  videoKeyframes=1
 *     audioPacketsForwarded=1497  lost=0
 *
 * Ninety-three video datagrams in half a minute, while the AUDIO leg of the
 * SAME ffmpeg process ran perfectly. That asymmetry is the whole clue: audio is
 * a few hundred bytes every 20 ms and never fills anything, while a 4K IDR is
 * on the order of a megabyte — ~750 datagrams at `pkt_size=1378` — delivered as
 * one burst. `dgram.createSocket()` sets no `SO_RCVBUF`, so the socket ran on
 * `net.core.rmem_default`: **212 992 bytes**, about a fifth of one key frame.
 * The burst overruns it, the kernel discards the remainder, and what survives
 * is exactly the observed trickle.
 *
 * ## Why a datagram lost HERE is invisible everywhere else
 *
 * A datagram the kernel drops for a full receive buffer never reaches a
 * `message` handler. From userspace it is indistinguishable from a packet
 * ffmpeg never wrote, so `videoPacketsForwarded` reads as a SOURCE-side gap and
 * the controller's Receiver Reports report no loss (we never transmitted the
 * packet, so it was never lost in flight). The only place the truth exists is
 * the kernel's per-socket `drops` column in `/proc/net/udp`, which
 * {@link parseUdpSocketDrops} reads. Without it this hypothesis cannot be
 * falsified from a log.
 *
 * ## The request may not be granted
 *
 * `SO_RCVBUF` is clamped at `net.core.rmem_max`, which the stock kernel sets to
 * 212 992 — the same number, so on a default host this fix would LOOK applied
 * and change nothing. This hub is at 16 MiB (host and container agree), so the
 * request lands. Every outcome reports what was requested AND what was granted;
 * a clamp is a host `sysctl net.core.rmem_max` away and is reported, never
 * silently worked around.
 *
 * Linux reports back DOUBLE what it stored (its own bookkeeping-overhead
 * allowance), so `effectiveBytes` is normally `2 × requestedBytes` on a granted
 * request. Anything BELOW the request is a clamp.
 */
import { readFileSync } from 'node:fs'

/**
 * What one 4K key frame needs to survive as a burst.
 *
 * ~1 MB of IDR at `pkt_size=1378` is ~750 datagrams, and the frames around it
 * keep arriving while it is being drained. Two megabytes is the floor below
 * which the burst is not survivable; it is a judgement threshold for the log
 * line, not a tuning knob.
 */
export const KEYFRAME_BURST_FLOOR_BYTES = 2 * 1024 * 1024

/**
 * What we ask for on the VIDEO loopback socket.
 *
 * Generous on purpose: the cost is virtual address space the kernel only
 * commits as datagrams actually queue, and the failure it prevents is a black
 * tile. Sized well above {@link KEYFRAME_BURST_FLOOR_BYTES} so a slow drain
 * (the JS forwarder is on the same event loop as everything else this addon
 * does) still has headroom.
 */
export const VIDEO_LOOPBACK_RCVBUF_BYTES = 8 * 1024 * 1024

/**
 * What we ask for on the AUDIO loopback socket.
 *
 * Audio never bursts — that is the control in this experiment, and it is why
 * the two legs get different numbers rather than one shared constant. If audio
 * ever starts dropping at the same buffer that carries video fine, the cause is
 * not burst size.
 */
export const AUDIO_LOOPBACK_RCVBUF_BYTES = 1024 * 1024

/**
 * The part of `dgram.Socket` this module touches. Named as an interface so the
 * clamp and the throw are both testable without a kernel.
 */
export interface ReceiveBufferSocket {
  setRecvBufferSize(size: number): void
  getRecvBufferSize(): number
}

export interface ReceiveBufferOutcome {
  readonly requestedBytes: number
  /** What `getsockopt(SO_RCVBUF)` reports back. `null` ⇒ unknowable. */
  readonly effectiveBytes: number | null
  /** The kernel granted LESS than we asked for — see `net.core.rmem_max`. */
  readonly clamped: boolean
  /**
   * Whether what we got can hold a 4K key-frame burst. `false` when unknown:
   * silence must never read as "fine".
   */
  readonly sufficientForKeyframeBurst: boolean
  readonly error: string | null
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Set `SO_RCVBUF` and READ IT BACK.
 *
 * Never throws: a platform that refuses the option must cost the buffer, never
 * the session. The read-back is the point — a request the kernel clamped and a
 * request it honoured are indistinguishable at the call site.
 */
export function applyReceiveBuffer(
  socket: ReceiveBufferSocket,
  requestedBytes: number,
): ReceiveBufferOutcome {
  let error: string | null = null
  try {
    socket.setRecvBufferSize(requestedBytes)
  } catch (err) {
    error = errMsg(err)
  }

  let effectiveBytes: number | null = null
  try {
    effectiveBytes = socket.getRecvBufferSize()
  } catch (err) {
    if (error === null) error = errMsg(err)
  }

  return {
    requestedBytes,
    effectiveBytes,
    clamped: effectiveBytes !== null && effectiveBytes < requestedBytes,
    sufficientForKeyframeBurst:
      effectiveBytes !== null && effectiveBytes >= KEYFRAME_BURST_FLOOR_BYTES,
    error,
  }
}

/** Where the kernel publishes per-socket UDP counters, by address family. */
const PROC_NET_UDP: Readonly<Record<'ipv4' | 'ipv6', string>> = {
  ipv4: '/proc/net/udp',
  ipv6: '/proc/net/udp6',
}

/**
 * The per-socket `drops` count for `port`, out of a `/proc/net/udp` table.
 *
 * Pure so the format assumption is pinned by a test rather than by a live
 * kernel. Returns `null` when the port has no row — which is NOT the same as
 * zero drops, and the two must never collapse: `0` is evidence the buffer held,
 * `null` is the absence of evidence.
 */
export function parseUdpSocketDrops(table: string, port: number): number | null {
  const lines = table.split('\n')
  for (const line of lines) {
    const fields = line.trim().split(/\s+/)
    // sl, local_address, rem_address, st, tx:rx, tr:when, retrnsmt, uid,
    // timeout, inode, ref, pointer, drops.
    if (fields.length < 13) continue
    const local = fields[1]
    if (local === undefined) continue
    const hexPort = local.split(':')[1]
    if (hexPort === undefined) continue
    const parsedPort = Number.parseInt(hexPort, 16)
    if (!Number.isFinite(parsedPort) || parsedPort !== port) continue
    const drops = Number(fields[fields.length - 1])
    return Number.isFinite(drops) ? drops : null
  }
  return null
}

/**
 * Fold a fresh drop sample into the one already held.
 *
 * A socket that has been CLOSED disappears from `/proc/net/udp`, so a resample
 * after teardown returns `null` — "I can no longer look", which must never
 * erase "I looked and it was 0". The first live session that proved the buffer
 * fix reported `videoLoopKernelDrops=null` for exactly this reason: on a
 * controller `stop` the sockets are closed synchronously while the summary is
 * emitted later from ffmpeg's `exit` handler.
 */
export function mergeDropSample(previous: number | null, sampled: number | null): number | null {
  return sampled ?? previous
}

/**
 * Read the kernel's drop counter for a bound local UDP port.
 *
 * Linux only — `null` on every other platform and on every read failure, which
 * is honest: "we could not look" and "nothing was dropped" are different
 * answers and this returns the first as `null`.
 *
 * Synchronous on purpose. It is called at the session heartbeat (5 s) and once
 * at teardown, against a memory-backed pseudo-file; making it async would mean
 * the SUMMARY line — the one line this experiment is read from — could not
 * carry a fresh count, which is the only reason it exists.
 */
export function readUdpSocketDrops(port: number, ipVersion: 'ipv4' | 'ipv6'): number | null {
  try {
    return parseUdpSocketDrops(readFileSync(PROC_NET_UDP[ipVersion], 'utf8'), port)
  } catch {
    return null
  }
}
