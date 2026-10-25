/**
 * cap-action-census — which cap METHOD moves the bytes, and how much of each
 * one this parent forwarded without ever reading it.
 *
 * ## Why `socket-traffic.ts` keeps no method, and why this is a separate file
 *
 * Read `socket-traffic.ts` before changing anything here. It does not omit the
 * method by oversight; three separate properties of that file forbid it, and
 * this module exists because each can be answered somewhere else rather than
 * relaxed:
 *
 * 1. **The channel does not know one.** `SocketChannel` sees a {@link
 *    import('./local-transport.js').Frame} — `{ k, id, body }` — and `body` is
 *    `unknown` by contract. The cap envelope lives one layer up, in
 *    `child-cap-protocol.ts`. A counter inside the channel that reached into
 *    `body.capName` would make the transport depend on the protocol it
 *    carries. So the LABEL is supplied from above ({@link capActionLabel}) and
 *    only the BYTES come from the wire.
 *
 * 2. **A `res` frame carries no method at all** — only its correlation `id`.
 *    And the responses are the whole question: measured 2026-09-11, hub-main
 *    wrote 144–262 MB/min to `hub/pipeline-analytics` on 1 966–2 411 responses
 *    (a 73–108 kB mean) against 2 kB of requests. Charging those bytes to a
 *    method is therefore not a counter at all, it is a CORRELATION: the label
 *    is taken off the `req`, held against its id, and settled when the `res`
 *    for that id is written. `socket-traffic.ts` is a two-addition hot path
 *    with no state per message; this is state per in-flight request, and the
 *    two do not belong in one file.
 *
 * 3. **Cardinality.** `recordSocketFrame` costs 2.37–2.41 ns and allocates
 *    nothing, on a path that runs ~44 000 times a second. Its docblock's rule
 *    — "an instrument that changes what it measures is not an instrument" — is
 *    the binding constraint, and a naive per-method map breaks it twice: a Map
 *    lookup and a counter object per method NAME, where the names arrive off
 *    the wire and are therefore unbounded in principle.
 *
 * ## What was chosen for the cardinality, and why not a sample
 *
 * **Full per-method counters in memory, bounded per peer; top-N only at REPORT
 * time.** The constraint that is real is the LINE's width (D446: Loki reads
 * these prefixes), not the map's size — and those are different limits:
 *
 *  - *Measured shape.* The cap-usage graph already keeps `(caller, provider,
 *    cap, method)` and, queried on this hub on 2026-09-11, holds **53 rows for
 *    the whole cluster** — 14 of them for `pipeline-analytics`, whose top three
 *    caps are 2 077 of its 2 141 calls/min. A peer uses a handful of methods,
 *    not hundreds. ~39 peers × a few dozen labels is a few hundred counter
 *    objects, each allocated ONCE and then only incremented. That is not an
 *    explosion; it is smaller than the `childEventStats` map next to it.
 *  - *The unbounded case is still refused*, because "measured today" is not a
 *    guarantee: {@link MAX_CAP_ACTIONS_PER_PEER} caps the distinct labels per
 *    peer and everything past it is charged to ONE
 *    {@link CAP_ACTION_OVERFLOW_LABEL} bucket. The bytes are never dropped —
 *    they stop being *named*, which is a different and visible failure.
 *  - *A sampled window was rejected.* The flow this exists to name is few,
 *    enormous responses: 1 966 responses carrying 144 MB. A 1-in-N sample of a
 *    distribution whose top item fires ~30 times a minute answers "probably"
 *    to a question that has an exact answer for the price of an integer add.
 *    And a sample that misses a method would report it as zero bytes, which is
 *    exactly the `null`-vs-`0` confusion D393 exists to forbid.
 *  - *A byte THRESHOLD was rejected for the same reason in reverse*: a
 *    threshold decides what to keep before it knows the window's shape, so the
 *    method that only matters during an episode is the one it discards. Rank
 *    at report time, when the totals are known.
 *
 * ## What a reader may conclude, and what it may not
 *
 * {@link CapActionWindow.labelledBytes} against `totalBytes` is the census's
 * own coverage, and it is on the line. Bytes this parent moved that carry no
 * cap envelope (`register`, `addon-call`, log and event frames) are charged to
 * {@link CAP_ACTION_UNLABELLED} rather than omitted: an instrument that
 * silently drops what it cannot classify reports a clean attribution of a
 * fraction it never names. A window whose `labelledBytes` is a small part of
 * `totalBytes` has NOT attributed the plane, and says so.
 *
 * ## Mutation, as in `socket-traffic.ts`
 *
 * Same deliberate exception, for the same measured reason: the counters are
 * plain mutable numbers written only by {@link CapActionCensus.record} and
 * friends, and read only through {@link CapActionCensus.read}, which COPIES.
 * The copy is not a nicety — the reporting layer subtracts the previous
 * reading, and a `read()` that handed back the live maps would advance the
 * baseline together with the counters and report every window as empty.
 */

/**
 * The channel's half of the census — see `socket-channel.ts` for the seam.
 *
 * The channel owns the BYTES and the request↔response correlation and NOTHING
 * else: it sees `{ k, id, body }` with `body: unknown`, and a `res` frame
 * carries no method at all. So the layer that understands the protocol supplies
 * {@link CapActionChannelObserver.label}, and the channel calls it once per
 * `req` frame, holds the answer against the frame's id, and settles it with
 * {@link CapActionChannelObserver.record} when the matching `res` is written or
 * read. A `null` label is still recorded — those bytes crossed, and a census
 * that drops what it cannot name reports a clean attribution of a fraction it
 * never mentions.
 *
 * Declared HERE rather than in the channel so `local-transport.ts` can name it
 * on {@link import('./local-transport.js').LocalChannel} without importing the
 * implementation that satisfies it.
 */
export interface CapActionChannelObserver {
  /** `<cap>.<method>`, or `null` for a frame that carries no cap envelope. */
  label(body: unknown): string | null
  /** One completed request/response pair, its on-the-wire bytes both ways. */
  record(label: string | null, reqBytes: number, resBytes: number): void
}

/** One action's cumulative cost on one peer's channel. Mutable by design. */
export interface CapActionCounters {
  /** Completed request/response pairs. */
  calls: number
  /** On-the-wire bytes of the requests, prefix and payload included. */
  reqBytes: number
  /** On-the-wire bytes of the answers. */
  resBytes: number
  /** Of `calls`, how many this parent forwarded without reading (D448). */
  raw: number
  /** Of `calls`, how many it materialised the args of. */
  decoded: number
}

/** An immutable reading of one action. */
export interface CapActionSample {
  readonly calls: number
  readonly reqBytes: number
  readonly resBytes: number
  readonly raw: number
  readonly decoded: number
}

/** One complete reading: peer → action → counters. */
export type CapActionReading = ReadonlyMap<string, ReadonlyMap<string, CapActionSample>>

/** A process that has never read the census. */
export const EMPTY_CAP_ACTION_READING: CapActionReading = new Map()

/**
 * Bytes that crossed on a frame carrying no cap envelope.
 *
 * Named rather than omitted so the census's coverage is readable off its own
 * output: `register`, `addon-call`, log frames and the event fan-out all land
 * here. A census that reported only what it could name would look like a
 * complete attribution of whatever share it happened to cover.
 */
export const CAP_ACTION_UNLABELLED = '(unlabelled)'

/** Bytes of actions past {@link MAX_CAP_ACTIONS_PER_PEER} on one peer. */
export const CAP_ACTION_OVERFLOW_LABEL = '(overflow)'

/**
 * Distinct named actions kept per peer before the overflow bucket takes over.
 *
 * Sixty-four against a measured worst case of 14 (`pipeline-analytics`, the
 * heaviest peer on this hub, 2026-09-11) — four times the observed shape, so a
 * peer has to change character before it overflows, and a bound that is never
 * reached in practice still forbids the unbounded growth a wire-supplied key
 * makes possible in principle.
 */
export const MAX_CAP_ACTIONS_PER_PEER = 64

/**
 * The cap envelopes, structurally. Not imported from `child-cap-protocol.ts`:
 * this module labels a `body` that arrived off a wire and has NOT been
 * validated, so it must state the shape it is willing to read rather than
 * assert a declared one.
 */
interface CapEnvelopeShape {
  readonly kind?: unknown
  readonly capName?: unknown
  readonly method?: unknown
}

/**
 * `<cap>.<method>` for a cap envelope, `null` for anything else.
 *
 * Both directions are labelled by the same function: a child's `cap-call-out`
 * and the parent's `cap-call` carry `capName` + `method` in the same two keys,
 * so one predicate covers the whole plane. Anything else — a `register`, an
 * `addon-call`, a log or an event — is deliberately unlabelled; see
 * {@link CAP_ACTION_UNLABELLED} for where its bytes go.
 *
 * Cost: two property reads, two `typeof`s and one concatenation of two short
 * strings, called once per `req` frame (not per frame). Against the
 * `encodeFrame` it sits beside — 1 948–1 975 ns on a 0.33 kB body — it is
 * noise, and unlike `recordSocketFrame` it is not on the `evt` path at all.
 */
export function capActionLabel(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const env = body as CapEnvelopeShape
  if (env.kind !== 'cap-call' && env.kind !== 'cap-call-out') return null
  if (typeof env.capName !== 'string' || typeof env.method !== 'string') return null
  return `${env.capName}.${env.method}`
}

/** Which half of D448's census one call fell on. */
export type CapActionForwardKind = 'raw' | 'decoded'

/** The census as its writers see it. */
export interface CapActionCensus {
  /** One completed request/response pair on `peerId`, charged to `action`. */
  record(peerId: string, action: string, reqBytes: number, resBytes: number): void
  /** How `action`'s most recent call was routed — see {@link CapActionForwardKind}. */
  recordForward(peerId: string, action: string, kind: CapActionForwardKind): void
  /** Bytes on a frame that carried no cap envelope. */
  recordUnlabelled(peerId: string, bytes: number): void
  /** Drop a peer's counters when its channel closes for good. */
  forget(peerId: string): void
  /** A COPY of the counters — see the module docblock on why it must be one. */
  read(): CapActionReading
}

function emptyCounters(): CapActionCounters {
  return { calls: 0, reqBytes: 0, resBytes: 0, raw: 0, decoded: 0 }
}

export function createCapActionCensus(): CapActionCensus {
  const peers = new Map<string, Map<string, CapActionCounters>>()

  /**
   * The per-peer slot for `action`, creating it under the bound.
   *
   * Past {@link MAX_CAP_ACTIONS_PER_PEER} a NEW label is folded into the
   * overflow bucket; labels already present keep their own slot, so a peer
   * that overflows does not lose the attribution it had built.
   */
  const slot = (peerId: string, action: string): CapActionCounters => {
    let byAction = peers.get(peerId)
    if (byAction === undefined) {
      byAction = new Map()
      peers.set(peerId, byAction)
    }
    const existing = byAction.get(action)
    if (existing !== undefined) return existing
    if (byAction.size >= MAX_CAP_ACTIONS_PER_PEER) {
      let overflow = byAction.get(CAP_ACTION_OVERFLOW_LABEL)
      if (overflow === undefined) {
        overflow = emptyCounters()
        byAction.set(CAP_ACTION_OVERFLOW_LABEL, overflow)
      }
      return overflow
    }
    const fresh = emptyCounters()
    byAction.set(action, fresh)
    return fresh
  }

  return {
    record(peerId, action, reqBytes, resBytes) {
      const c = slot(peerId, action)
      c.calls += 1
      c.reqBytes += reqBytes
      c.resBytes += resBytes
    },
    recordForward(peerId, action, kind) {
      const c = slot(peerId, action)
      if (kind === 'raw') c.raw += 1
      else c.decoded += 1
    },
    recordUnlabelled(peerId, bytes) {
      const c = slot(peerId, CAP_ACTION_UNLABELLED)
      c.resBytes += bytes
    },
    forget(peerId) {
      peers.delete(peerId)
    },
    read() {
      const out = new Map<string, ReadonlyMap<string, CapActionSample>>()
      for (const [peerId, byAction] of peers) {
        const copy = new Map<string, CapActionSample>()
        for (const [action, c] of byAction) {
          copy.set(action, {
            calls: c.calls,
            reqBytes: c.reqBytes,
            resBytes: c.resBytes,
            raw: c.raw,
            decoded: c.decoded,
          })
        }
        out.set(peerId, copy)
      }
      return out
    },
  }
}

/** One (peer, action) pair over the window since the previous reading. */
export interface CapActionDelta {
  readonly peerId: string
  readonly action: string
  readonly calls: number
  readonly reqBytes: number
  readonly resBytes: number
  readonly raw: number
  readonly decoded: number
}

/** The census over one heartbeat window. */
export interface CapActionWindow {
  /**
   * Heaviest first by `reqBytes + resBytes`, at most the requested N.
   *
   * By BYTES and never by calls, for the reason D454 records: the flow this
   * exists to name is few, enormous responses, and a ranking by count cannot
   * see it by construction.
   */
  readonly top: readonly CapActionDelta[]
  /** Bytes the census could put a cap method on, this window. */
  readonly labelledBytes: number
  /** Every byte it saw, named or not. `labelled/total` is its own coverage. */
  readonly totalBytes: number
}

function sampleOf(
  reading: CapActionReading,
  peerId: string,
  action: string,
): CapActionSample | undefined {
  return reading.get(peerId)?.get(action)
}

/**
 * Subtract the previous reading from the current one.
 *
 * A peer whose runner RESPAWNED reconnects under the same id with counters
 * that went backwards. Clamped at 0, exactly as `diffSocketPlane` clamps for
 * the same reason: its traffic in that window is genuinely unknown, and a
 * negative number on a rate reads as a broken meter.
 */
export function diffCapActionCensus(
  before: CapActionReading,
  current: CapActionReading,
  topN: number,
): CapActionWindow {
  const deltas: CapActionDelta[] = []
  let labelledBytes = 0
  let totalBytes = 0
  for (const [peerId, byAction] of current) {
    for (const [action, now] of byAction) {
      const then = sampleOf(before, peerId, action)
      const reqBytes = Math.max(0, now.reqBytes - (then?.reqBytes ?? 0))
      const resBytes = Math.max(0, now.resBytes - (then?.resBytes ?? 0))
      const bytes = reqBytes + resBytes
      totalBytes += bytes
      if (action === CAP_ACTION_UNLABELLED || action === CAP_ACTION_OVERFLOW_LABEL) continue
      labelledBytes += bytes
      if (bytes === 0) continue
      deltas.push({
        peerId,
        action,
        calls: Math.max(0, now.calls - (then?.calls ?? 0)),
        reqBytes,
        resBytes,
        raw: Math.max(0, now.raw - (then?.raw ?? 0)),
        decoded: Math.max(0, now.decoded - (then?.decoded ?? 0)),
      })
    }
  }
  return {
    top: deltas
      .toSorted(
        (a, b) =>
          b.reqBytes + b.resBytes - (a.reqBytes + a.resBytes) ||
          a.peerId.localeCompare(b.peerId) ||
          a.action.localeCompare(b.action),
      )
      .slice(0, topN),
    labelledBytes,
    totalBytes,
  }
}
