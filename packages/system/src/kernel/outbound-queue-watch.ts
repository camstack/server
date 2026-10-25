/**
 * outbound-queue-watch — an outbound socket queue that HOLDS is named, and its
 * release is timestamped (D446).
 *
 * ## The blind spot this closes
 *
 * On 2026-09-10 hub-main's `arrayBuffers` climbed twice at a constant rate
 * (20 MB/min to 1 264 MB; 63 MB/min for 77 min to 4 968 MB), LIVE across a
 * forced compaction, with ~4 % of JS heap alongside, and each time released in
 * one instant with no line from any owner. The investigation excluded "every
 * socket write queue" by summing `writableLength` over
 * `process._getActiveHandles()` — 84 MB, all of it the phone's WebSocket.
 *
 * `_getActiveHandles()` lists only handles that keep the loop alive. An
 * UNREF'D socket is not one of them, and Moleculer's `TcpWriter.connect`
 * unrefs every socket it opens to a peer node (`transporters/tcp/tcp-writer.js`,
 * `socket.unref()`). So the one outbound plane that writes to another MACHINE
 * — where a reader that stops draining is the ordinary failure — was never in
 * the sum. The UDS children were in it, but only as a total, at one instant,
 * by hand.
 *
 * ## What this is
 *
 * A pure gate over per-peer queue depths the heartbeat reads on every probe:
 * the UDS children's `socket.writableLength` (`SocketChannel.queuedBytes`) and
 * the mesh writer sockets' (`mesh-queue-report.ts`). It says three things and
 * nothing else:
 *
 *  - a peer whose queue has been at or above {@link OUTBOUND_QUEUE_THRESHOLD_BYTES}
 *    for {@link OUTBOUND_QUEUE_SUSTAIN_MS} is NAMED, with its current and peak
 *    depth and how long it has held — at most once per
 *    {@link OUTBOUND_QUEUE_COOLDOWN_MS};
 *  - a named peer whose queue then falls under half the threshold, or that
 *    vanishes from the readings (its socket died — which is how a queue is
 *    dropped in one instant), is reported as RELEASED with its peak and the
 *    hold, so the release the episodes never logged has a line and a peer;
 *  - a burst that drains inside the sustain window says nothing. Backpressure
 *    measures LIVENESS, not identity (D444): a peer momentarily behind is
 *    coming back.
 *
 * ## What it is NOT
 *
 * Not a bound. It terminates nothing: a UDS child whose channel is destroyed
 * loses every in-flight call, and a mesh socket Moleculer reconnects on its
 * own terms. The WS guard (`ws-slow-consumer-guard.ts`) bounds the one plane
 * whose client is expendable. Here the line is the deliverable; what to do
 * about a peer that holds is decided with the peer named, not before.
 */

/** 64 MiB. Below this a queue is a burst on a busy peer (the orchestrator's
 *  channel moves ~1.5 MB/s of audio responses); above it, and held, it is
 *  retention with a name. */
export const OUTBOUND_QUEUE_THRESHOLD_BYTES: number = 64 * 1024 * 1024
/** Matches the ArrayBuffer census sustain: a minute above the bound. */
export const OUTBOUND_QUEUE_SUSTAIN_MS = 60_000
/** A held queue is re-named every ten minutes, not every probe. */
export const OUTBOUND_QUEUE_COOLDOWN_MS: number = 10 * 60_000
/** A release is a fall under this fraction of the threshold. */
const RELEASE_RATIO = 0.5

/** One outbound channel's queue depth at one probe. `peerId` carries its
 *  plane as a prefix (`uds:<childId>`, `mesh:<nodeId>`). */
export interface OutboundQueueReading {
  readonly peerId: string
  readonly bytes: number
}

export type OutboundQueueVerdict =
  | {
      readonly kind: 'sustained'
      readonly peerId: string
      readonly bytes: number
      readonly peakBytes: number
      readonly heldForMs: number
    }
  | {
      readonly kind: 'released'
      readonly peerId: string
      readonly peakBytes: number
      readonly toBytes: number
      readonly heldForMs: number
      /** The peer left the readings altogether — its socket is gone. */
      readonly gone: boolean
    }

export interface OutboundQueueGateOptions {
  readonly thresholdBytes?: number
  readonly sustainMs?: number
  readonly cooldownMs?: number
}

export interface OutboundQueueGate {
  /** Judge one probe's readings. Every peer is judged on its own. */
  readonly observe: (
    readings: readonly OutboundQueueReading[],
    at: number,
  ) => readonly OutboundQueueVerdict[]
}

interface PeerState {
  readonly aboveSince: number
  readonly peakBytes: number
  readonly lastNamedAt: number | null
}

/**
 * The pure decision — threshold, sustain, cooldown, release, gone — testable
 * without a socket.
 */
export function createOutboundQueueGate(options: OutboundQueueGateOptions = {}): OutboundQueueGate {
  const thresholdBytes = options.thresholdBytes ?? OUTBOUND_QUEUE_THRESHOLD_BYTES
  const sustainMs = options.sustainMs ?? OUTBOUND_QUEUE_SUSTAIN_MS
  const cooldownMs = options.cooldownMs ?? OUTBOUND_QUEUE_COOLDOWN_MS
  const tracked = new Map<string, PeerState>()

  const judgeOne = (
    peerId: string,
    bytes: number,
    at: number,
  ): OutboundQueueVerdict | undefined => {
    const state = tracked.get(peerId)
    if (bytes >= thresholdBytes) {
      const next: PeerState =
        state === undefined
          ? { aboveSince: at, peakBytes: bytes, lastNamedAt: null }
          : { ...state, peakBytes: Math.max(state.peakBytes, bytes) }
      const heldForMs = at - next.aboveSince
      const due =
        heldForMs >= sustainMs && (next.lastNamedAt === null || at - next.lastNamedAt >= cooldownMs)
      tracked.set(peerId, due ? { ...next, lastNamedAt: at } : next)
      return due
        ? { kind: 'sustained', peerId, bytes, peakBytes: next.peakBytes, heldForMs }
        : undefined
    }
    if (state === undefined) return undefined
    if (bytes >= thresholdBytes * RELEASE_RATIO) return undefined
    tracked.delete(peerId)
    // Only a hold that was NAMED gets a release line: a burst that drained
    // inside the window was never an episode, and reporting its end would
    // put a "release" in the log for every busy minute on the orchestrator.
    if (state.lastNamedAt === null) return undefined
    return {
      kind: 'released',
      peerId,
      peakBytes: state.peakBytes,
      toBytes: bytes,
      heldForMs: at - state.aboveSince,
      gone: false,
    }
  }

  return {
    observe(readings, at) {
      const verdicts: OutboundQueueVerdict[] = []
      const seen = new Set<string>()
      for (const reading of readings) {
        seen.add(reading.peerId)
        const verdict = judgeOne(reading.peerId, reading.bytes, at)
        if (verdict !== undefined) verdicts.push(verdict)
      }
      // A tracked peer that is no longer read at all: its channel closed, and
      // a closed channel drops its whole queue in one instant — exactly the
      // shape the 2026-09-10 releases had.
      for (const [peerId, state] of tracked) {
        if (seen.has(peerId)) continue
        tracked.delete(peerId)
        if (state.lastNamedAt === null) continue
        verdicts.push({
          kind: 'released',
          peerId,
          peakBytes: state.peakBytes,
          toBytes: 0,
          heldForMs: at - state.aboveSince,
          gone: true,
        })
      }
      return verdicts
    },
  }
}

const BYTES_PER_MB = 1048576

function mb(bytes: number): number {
  return Math.round(bytes / BYTES_PER_MB)
}

/** `60s` under two minutes, `77m` from there — the hold is read at a glance. */
function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)}m`
}

/** The line for one verdict. Both carry the peer, the bytes and the hold;
 *  the sustained one also says why the older census could not see it. */
export function formatOutboundQueueVerdict(label: string, verdict: OutboundQueueVerdict): string {
  if (verdict.kind === 'sustained') {
    return (
      `[mem] ${label} outbound queue to ${verdict.peerId} has held ${mb(verdict.bytes)}MB ` +
      `(peak ${mb(verdict.peakBytes)}MB) for ${duration(verdict.heldForMs)} — the peer is not ` +
      `draining what this process writes to it. This is socket.writableLength on the channel ` +
      `itself; a sum over _getActiveHandles() does not list an unref'd socket and would miss it.`
    )
  }
  return (
    `[mem] ${label} outbound queue to ${verdict.peerId} RELEASED — ${mb(verdict.peakBytes)}MB ` +
    `at peak, ${mb(verdict.toBytes)}MB now, held ${duration(verdict.heldForMs)}` +
    (verdict.gone ? ' (peer gone: the socket closed and dropped its queue)' : ' (drained)')
  )
}
