/**
 * socket-plane-report — which PEER, exchanging what KIND of message, accounts
 * for hub-main's ~44 000 socket syscalls per second.
 *
 * ## Why this exists, and why it is not the fan-out report
 *
 * `event-plane-report.ts` surfaced the counters the cluster had always kept and
 * never read. It answered its own question and, in answering it, sharpened this
 * one: measured 2026-08-29, **the event plane is 4 % of hub-main's socket
 * traffic**. The remaining 96 % — ~22 000 reads/s and ~22 500 writes/s at a
 * 0.33 KB mean, on the process that mediates every cross-runner call — had no
 * instrument at all, and no instrument was obtainable:
 *
 *  - `/proc/<pid>/io` gives ONE `rchar`/`wchar` pair for the whole process.
 *    There is no per-socket breakdown anywhere in `/proc`.
 *  - The strongest attribution available was a correlation — 78–82 % of
 *    hub-main's outbound bytes moving with `hub/pipeline-analytics`, in both
 *    measured windows — computed from that runner's own `rchar`, which also
 *    counts page-cache file reads on a runner that owns a vector store. A
 *    correlation this stable is worth one counter to settle; it is not itself
 *    an answer.
 *  - Three separate inferences about this traffic were closed early on
 *    2026-08-29 and were wrong. The point of this module is that the next pass
 *    is evidence.
 *
 * ## What it reports, and why each field is load-bearing
 *
 * Per kind, per direction, cluster-wide, plus the top peers:
 *
 *  - **`evt`** scales with the number of RUNNERS, not with anything an operator
 *    asked for — an idle `hub/ml` still reads 82 messages/s. If `evt` dominates,
 *    the cost is the plane's own shape and the fix is the fan-out gate.
 *  - **`req`** scales with work. If `req` dominates, some caller is chatty and
 *    the fix is that caller.
 *  - **`res`** is where a large payload can hide (a GOP crosses hub-main as a
 *    msgpack `Uint8Array` inside a `res`). **This is the falsifier**: the
 *    "message-RATE, not media" conclusion of
 *    `docs/design/2026-08-29-hub-main-memory-what-crosses-it.md` §4 rests on a
 *    0.33/0.40 KB mean, and `res` bytes dominating at a large mean breaks it and
 *    re-opens the D9/D18 question. Bytes are reported beside messages on every
 *    kind precisely so the mean can be read off the line.
 *
 * ## Deltas, never totals
 *
 * The channel counters are cumulative for the life of the channel. A cumulative
 * number on a heartbeat answers "how much since boot", which nobody asked; the
 * question is a rate. So the meter is read ONCE PER LINE and reports the window
 * since the previous read — the same discipline the loop-delay histogram and
 * the fan-out counters already follow, for the same reason.
 *
 * A peer whose runner RESPAWNED reconnects under the same id with a fresh
 * channel and counters that went backwards. Clamping at 0 reports that window
 * as quiet rather than negative: its traffic is genuinely unknown, and a
 * negative number on a rate reads as a broken meter.
 *
 * ## What this is NOT
 *
 * It is not a bound, a budget or a throttle. Nothing here changes a default,
 * drops a frame or tunes a socket. It counts what already crosses, so that the
 * thing that eventually gets fixed is chosen from evidence.
 */
import {
  diffCapActionCensus,
  EMPTY_CAP_ACTION_READING,
  type CapActionReading,
  type CapActionWindow,
} from './transport/cap-action-census.js'
import {
  EMPTY_SOCKET_DIRECTION,
  socketDirectionBytes,
  socketDirectionMessages,
  type SocketDirectionSample,
  type SocketTrafficSample,
} from './transport/socket-traffic.js'

/** One peer's cumulative traffic, as the channel keeps it, plus its outbound
 *  queue depth at the instant of the read. */
export interface SocketPeerSample {
  readonly peerId: string
  readonly tx: SocketDirectionSample
  readonly rx: SocketDirectionSample
  /**
   * Bytes written to this peer that it has not yet taken — `writableLength`
   * on the channel, read live (D446). `null` when the channel keeps no such
   * reading: a measurement that failed is null, never 0 (D393), and the
   * window counts it as unmeasured rather than as empty.
   */
  readonly queuedBytes: number | null
}

/** What `LocalChildRegistry` exposes, structurally — the kernel's heartbeat
 *  must not depend on the transport layer's class. */
export interface SocketPlaneRegistryChild {
  readonly childId: string
}

/**
 * How many child→sibling cap calls the parent forwarded without reading
 * their args (`raw`) against how many it decoded — see
 * `transport/local-child-registry.ts` `ForwardCensus`. Cumulative on the
 * registry; a delta on the window.
 */
export interface SocketForwardCensus {
  readonly raw: number
  readonly decoded: number
}

export interface SocketPlaneRegistry {
  readonly listChildren: () => readonly SocketPlaneRegistryChild[]
  readonly getChildSocketTraffic: (childId: string) => SocketTrafficSample | null
  /** Live outbound queue depth to one child, or `null` when unmeasured. */
  readonly getChildQueuedBytes: (childId: string) => number | null
  /**
   * The raw-forward census, when the registry keeps one. OPTIONAL: a registry
   * that predates raw-forward has no such number, and the line must then omit
   * the field rather than print a zero that reads as "nothing was forwarded".
   */
  readonly readForwardCensus?: () => SocketForwardCensus
  /**
   * The per-ACTION byte census, when the registry keeps one (D456).
   *
   * OPTIONAL on the same terms as {@link readForwardCensus}: a registry whose
   * channels carry no byte counters has nothing to attribute, and the line
   * must omit the fields rather than print a `0/0` that reads as "the plane
   * moved nothing" instead of "nobody measured".
   */
  readonly readActionCensus?: () => CapActionReading
}

/** One cumulative reading of every measured peer. */
export interface SocketPlaneCounters {
  readonly peers: readonly SocketPeerSample[]
  /** Connected children, INCLUDING any whose channel keeps no counters. */
  readonly peersConnected: number
  /** Cumulative forward census, absent when the registry keeps none. */
  readonly forward?: SocketForwardCensus
  /** Cumulative per-action census, absent when the registry keeps none. */
  readonly actions?: CapActionReading
}

/** `undefined` = this process has no local socket plane to report (every forked
 *  runner, and hub-main before the registry exists). */
export type SocketPlaneReader = () => SocketPlaneCounters | undefined

/** Where a reader gets its registry. Late-bound, because the heartbeat starts
 *  before the registry exists. */
export interface SocketPlaneSources {
  readonly registry: () => SocketPlaneRegistry | null
}

/**
 * Build a reader over the child registry.
 *
 * Returns `undefined` until the registry exists — the heartbeat starts as the
 * FIRST statement of `bootstrap()` and `LocalChildRegistry` is built hundreds
 * of lines later. Printing zeros in that window would report a silent plane
 * where there is no plane at all.
 *
 * Wrapped: a registry mid-teardown may throw, and a diagnostic that can crash
 * the process it watches is worse than none.
 */
export function createSocketPlaneReader(sources: SocketPlaneSources): SocketPlaneReader {
  return (): SocketPlaneCounters | undefined => {
    try {
      const registry = sources.registry()
      if (registry === null) return undefined
      const listed = registry.listChildren()
      const peers: SocketPeerSample[] = []
      for (const child of listed) {
        const traffic = registry.getChildSocketTraffic(child.childId)
        // A channel that keeps no counters is UNMEASURED, not silent, so it
        // simply does not appear — `peersConnected` still counts it, which is
        // what makes the difference visible.
        if (traffic === null) continue
        peers.push({
          peerId: child.childId,
          tx: traffic.tx,
          rx: traffic.rx,
          queuedBytes: registry.getChildQueuedBytes(child.childId),
        })
      }
      const forward = registry.readForwardCensus?.()
      const actions = registry.readActionCensus?.()
      return {
        peers,
        peersConnected: listed.length,
        ...(forward === undefined ? {} : { forward }),
        ...(actions === undefined ? {} : { actions }),
      }
    } catch {
      return undefined
    }
  }
}

/**
 * How many peers get named on the line.
 *
 * Five, matching `EVENT_PLANE_TOP_N` for the same reason: the measured
 * distribution is not flat — one peer accounted for 78–82 % of outbound bytes
 * and the runner-up for ~6 % — so five names the dominant peer, its challenger
 * and enough of the tail to see the shape change. Naming all ~38 would put a
 * kilobyte-long line in the hub's shared log every minute, which is how a log
 * stops being read.
 */
export const SOCKET_PLANE_TOP_N = 5

/** One peer's traffic over the window since the previous read. */
export interface SocketPeerDelta {
  readonly peerId: string
  readonly tx: SocketDirectionSample
  readonly rx: SocketDirectionSample
}

/** One peer holding an outbound queue at the instant of the read. */
export interface SocketPeerQueue {
  readonly peerId: string
  readonly bytes: number
}

/**
 * The outbound queues at the instant of the read — NOT a delta: a queue is a
 * level, and the level is the reading (D446).
 */
export interface SocketQueueReading {
  /** Summed over every peer with a reading. */
  readonly totalBytes: number
  /** Peers whose channel keeps no queue reading. Never folded into the total. */
  readonly unmeasured: number
  /** Peers holding a queue, largest first, at most {@link SOCKET_QUEUE_TOP_N}. */
  readonly top: readonly SocketPeerQueue[]
}

/** The whole plane over one heartbeat window. */
export interface SocketPlaneWindow {
  readonly peersConnected: number
  /** Peers that reported counters. Below `peersConnected` ⇒ unmeasured channels. */
  readonly peersMeasured: number
  /** Summed over every measured peer. */
  readonly tx: SocketDirectionSample
  readonly rx: SocketDirectionSample
  /** Busiest first (tx+rx messages), at most {@link SOCKET_PLANE_TOP_N}. */
  readonly top: readonly SocketPeerDelta[]
  /**
   * Heaviest first (tx+rx BYTES), at most {@link SOCKET_PLANE_TOP_N}.
   *
   * A separate ranking rather than a replacement, because the two questions
   * have different answers and both are live: `top` names the peer paying for
   * round trips (`audio-codec` at 8 379 calls/min of small frames), `topBytes`
   * names the peer paying for copies and GC. A peer that moves FEW, HUGE
   * frames is absent from `top` by construction — measured 2026-09-11, the
   * five peers named by messages left 116 MB/min of hub-main's outbound bytes
   * with no name on them (D454).
   */
  readonly topBytes: readonly SocketPeerDelta[]
  readonly queued: SocketQueueReading
  /** Forwards in this window, absent when the registry keeps no census. */
  readonly forward?: SocketForwardCensus
  /**
   * The per-action census over this window, absent when none is kept.
   *
   * This is the field that survives raw-forward. Once 85.7 % of sibling calls
   * cross hub-main without being read (D448, measured on 1.2.270), the bytes
   * a peer moves stop being the proxy for what hub-main PAYS — a forwarded
   * body costs a memcpy, a decoded one costs msgpack plus the garbage. So the
   * entry carries the raw/decoded split BESIDE the bytes, per method, and the
   * two questions are read off one row.
   */
  readonly actions?: CapActionWindow
}

/** How many queue-holding peers get named. Three: a queue is an exception,
 *  and the line already carries five names for traffic. */
export const SOCKET_QUEUE_TOP_N = 3

/**
 * How many (peer, action) pairs get named.
 *
 * Five, matching {@link SOCKET_PLANE_TOP_N}, and for the same measured reason:
 * the distribution is not flat. Queried on this hub 2026-09-11, the heaviest
 * peer's top THREE caps were 2 077 of its 2 141 calls/min — five names the
 * dominant action, its challenger, and enough of the tail to see the shape
 * change. The map behind it keeps every action (see `cap-action-census.ts` on
 * why the bound that matters is the line's width, not the map's size); this
 * constant governs only what is printed.
 */
export const SOCKET_ACTION_TOP_N = 5

/** The queue reading over the current counters — a level, so no baseline. */
export function readSocketQueues(current: SocketPlaneCounters): SocketQueueReading {
  let totalBytes = 0
  let unmeasured = 0
  const holding: SocketPeerQueue[] = []
  for (const peer of current.peers) {
    if (peer.queuedBytes === null) {
      unmeasured += 1
      continue
    }
    totalBytes += peer.queuedBytes
    if (peer.queuedBytes > 0) holding.push({ peerId: peer.peerId, bytes: peer.queuedBytes })
  }
  return {
    totalBytes,
    unmeasured,
    top: holding
      .toSorted((a, b) => b.bytes - a.bytes || a.peerId.localeCompare(b.peerId))
      .slice(0, SOCKET_QUEUE_TOP_N),
  }
}

/** Previous cumulative reading, kept between lines. */
export interface SocketPlaneBaseline {
  readonly peers: ReadonlyMap<string, SocketPeerSample>
  readonly forward?: SocketForwardCensus
  /** Previous per-action reading; absent = nothing has been read yet. */
  readonly actions?: CapActionReading
}

/** A process that has never read the plane. */
export const EMPTY_SOCKET_PLANE_BASELINE: SocketPlaneBaseline = { peers: new Map() }

/** The census over the window; a counter that went backwards reads as quiet. */
function diffForward(
  current: SocketForwardCensus | undefined,
  before: SocketForwardCensus | undefined,
): SocketForwardCensus | undefined {
  if (current === undefined) return undefined
  return {
    raw: Math.max(0, current.raw - (before?.raw ?? 0)),
    decoded: Math.max(0, current.decoded - (before?.decoded ?? 0)),
  }
}

function diffDirection(
  current: SocketDirectionSample,
  before: SocketDirectionSample | undefined,
): SocketDirectionSample {
  const previous = before ?? EMPTY_SOCKET_DIRECTION
  return {
    reqMessages: Math.max(0, current.reqMessages - previous.reqMessages),
    reqBytes: Math.max(0, current.reqBytes - previous.reqBytes),
    resMessages: Math.max(0, current.resMessages - previous.resMessages),
    resBytes: Math.max(0, current.resBytes - previous.resBytes),
    evtMessages: Math.max(0, current.evtMessages - previous.evtMessages),
    evtBytes: Math.max(0, current.evtBytes - previous.evtBytes),
  }
}

function addDirection(
  into: SocketDirectionSample,
  add: SocketDirectionSample,
): SocketDirectionSample {
  return {
    reqMessages: into.reqMessages + add.reqMessages,
    reqBytes: into.reqBytes + add.reqBytes,
    resMessages: into.resMessages + add.resMessages,
    resBytes: into.resBytes + add.resBytes,
    evtMessages: into.evtMessages + add.evtMessages,
    evtBytes: into.evtBytes + add.evtBytes,
  }
}

/** Total messages a peer moved in the window, both directions. */
function peerMessages(delta: SocketPeerDelta): number {
  return socketDirectionMessages(delta.tx) + socketDirectionMessages(delta.rx)
}

/**
 * Total bytes a peer moved in the window, both directions — the OTHER
 * ranking, and the one that names a peer the message ranking structurally
 * cannot see (D454).
 */
function peerBytes(delta: SocketPeerDelta): number {
  return socketDirectionBytes(delta.tx) + socketDirectionBytes(delta.rx)
}

/** Subtract the previous cumulative reading from the current one. */
export function diffSocketPlane(
  baseline: SocketPlaneBaseline,
  current: SocketPlaneCounters,
  topN: number = SOCKET_PLANE_TOP_N,
): SocketPlaneWindow {
  const deltas: SocketPeerDelta[] = []
  let tx: SocketDirectionSample = EMPTY_SOCKET_DIRECTION
  let rx: SocketDirectionSample = EMPTY_SOCKET_DIRECTION
  for (const sample of current.peers) {
    const before = baseline.peers.get(sample.peerId)
    const delta: SocketPeerDelta = {
      peerId: sample.peerId,
      tx: diffDirection(sample.tx, before?.tx),
      rx: diffDirection(sample.rx, before?.rx),
    }
    tx = addDirection(tx, delta.tx)
    rx = addDirection(rx, delta.rx)
    if (peerMessages(delta) > 0) deltas.push(delta)
  }
  const forward = diffForward(current.forward, baseline.forward)
  const actions =
    current.actions === undefined
      ? undefined
      : diffCapActionCensus(
          baseline.actions ?? EMPTY_CAP_ACTION_READING,
          current.actions,
          SOCKET_ACTION_TOP_N,
        )
  return {
    peersConnected: current.peersConnected,
    peersMeasured: current.peers.length,
    tx,
    rx,
    top: deltas
      .toSorted((a, b) => peerMessages(b) - peerMessages(a) || a.peerId.localeCompare(b.peerId))
      .slice(0, topN),
    topBytes: deltas
      .toSorted((a, b) => peerBytes(b) - peerBytes(a) || a.peerId.localeCompare(b.peerId))
      .slice(0, topN),
    queued: readSocketQueues(current),
    ...(forward === undefined ? {} : { forward }),
    ...(actions === undefined ? {} : { actions }),
  }
}

/** Reads the delta since the PREVIOUS read. Same contract as the loop meter. */
export interface SocketPlaneMeter {
  readonly read: () => SocketPlaneWindow | undefined
}

export function createSocketPlaneMeter(
  reader: SocketPlaneReader,
  topN: number = SOCKET_PLANE_TOP_N,
): SocketPlaneMeter {
  let baseline: SocketPlaneBaseline = EMPTY_SOCKET_PLANE_BASELINE
  return {
    read: (): SocketPlaneWindow | undefined => {
      const current = reader()
      if (current === undefined) return undefined
      const window = diffSocketPlane(baseline, current, topN)
      baseline = {
        peers: new Map(current.peers.map((p) => [p.peerId, p])),
        ...(current.forward === undefined ? {} : { forward: current.forward }),
        ...(current.actions === undefined ? {} : { actions: current.actions }),
      }
      return window
    },
  }
}

/** Bytes → whole kB. The plane moves 180–330 MB/min; raw bytes would put
 *  nine-digit numbers on a line that has to stay readable. */
function kb(bytes: number): number {
  return Math.round(bytes / 1024)
}

/** `req:<msgs>/<kB>,res:<msgs>/<kB>,evt:<msgs>/<kB>` — every kind, always,
 *  including at zero: a kind that went quiet is a reading, not a blank. */
function formatDirection(sample: SocketDirectionSample): string {
  return (
    `req:${sample.reqMessages}/${kb(sample.reqBytes)}kB,` +
    `res:${sample.resMessages}/${kb(sample.resBytes)}kB,` +
    `evt:${sample.evtMessages}/${kb(sample.evtBytes)}kB`
  )
}

/** `<req>/<res>/<evt>` in kB — the byte triple, in the same order as the
 *  message triple next to it, so the two read as one table. */
function formatPeerBytes(sample: SocketDirectionSample): string {
  return `${kb(sample.reqBytes)}/${kb(sample.resBytes)}/${kb(sample.evtBytes)}`
}

/**
 * `<peer>:tx=<req>/<res>/<evt>:rx=…:txkB=<req>/<res>/<evt>:rxkB=…` — the whole
 * peer×kind cross for one peer, messages and bytes, which is the question in
 * one token.
 *
 * The bytes were a per-direction TOTAL until D454, and the total could not
 * answer the question `socket-traffic.ts` says this instrument exists to
 * settle: whether a peer's bytes are RESPONSES (media, and D9/D18 re-opens) or
 * fan-out (`evt`, which scales with runner count and nothing an operator
 * asked for). On 2026-09-11 hub-main wrote 118 MB in one minute to
 * `hub/pipeline-analytics` and the line could only say "118 MB" — separating
 * `res` from `evt` took an hour of arithmetic against the plane-wide totals.
 */
function formatPeer(delta: SocketPeerDelta): string {
  return (
    `${delta.peerId}:` +
    `tx=${delta.tx.reqMessages}/${delta.tx.resMessages}/${delta.tx.evtMessages}:` +
    `rx=${delta.rx.reqMessages}/${delta.rx.resMessages}/${delta.rx.evtMessages}:` +
    `txkB=${formatPeerBytes(delta.tx)}:` +
    `rxkB=${formatPeerBytes(delta.rx)}`
  )
}

/**
 * One named action: `<peer>!<cap>.<method>:<kB>kB/<calls>:r<raw>/d<decoded>`.
 *
 * `!` separates the peer from the action because `.` already separates cap
 * from method and a single delimiter for both would make the token ambiguous
 * to split.
 *
 * The raw/decoded pair is the half that did not exist anywhere before D456.
 * `socketFwd=` answers it for the whole plane — 30 349/5 051 on this hub — and
 * a plane-wide ratio cannot tell a method that is entirely forwarded from one
 * that is entirely decoded, which is the difference between bytes hub-main
 * copies and bytes hub-main reads. The census pays for the two counters it
 * takes; the conclusion they buy is which of the line's megabytes are actually
 * expensive.
 */
function formatAction(entry: CapActionWindow['top'][number]): string {
  return (
    `${entry.peerId}!${entry.action}:` +
    `${kb(entry.reqBytes + entry.resBytes)}kB/${entry.calls}:` +
    `r${entry.raw}/d${entry.decoded}`
  )
}

/**
 * The suffix appended to a `[mem]` line — leading space included, empty when
 * this process has no local socket plane.
 *
 * Only the processes that OWN a child registry have one (hub-main, and an
 * agent's main), so these fields never appear on the ~38 runner lines that
 * share the same log stream. On the ones that do, every field is printed on
 * every line including at zero — `socketPeers` because measured-below-connected
 * is the only way to see an unmeasured channel, and the per-kind splits because
 * "the plane went quiet for a minute" is a reading.
 *
 * `socketTop` is a conditional field — a ranked list of nothing is noise — and
 * it is a single comma-separated value so the field COUNT does not change from
 * line to line.
 *
 * `socketTopBytes` is the other one, and its PRESENCE is the reading: it is
 * printed only when ranking by bytes names a peer that ranking by messages
 * does not. A line without it says the two rankings agree; a line with it says
 * a peer is moving few, heavy frames and names it (D454).
 */
export function formatSocketPlane(window: SocketPlaneWindow | undefined): string {
  if (window === undefined) return ''
  const top = window.top.map(formatPeer).join(',')
  const named = new Set(window.top.map((p) => p.peerId))
  const topBytes = window.topBytes
    .filter((p) => !named.has(p.peerId))
    .map(formatPeer)
    .join(',')
  const queuedTop = window.queued.top.map((p) => `${p.peerId}:${kb(p.bytes)}`).join(',')
  return (
    ` socketPeers=${window.peersMeasured}/${window.peersConnected}` +
    ` socketTx=${formatDirection(window.tx)}` +
    ` socketRx=${formatDirection(window.rx)}` +
    (top.length === 0 ? '' : ` socketTop=${top}`) +
    (topBytes.length === 0 ? '' : ` socketTopBytes=${topBytes}`) +
    // The queue fields come AFTER the traffic ranking so `socketTop=` keeps
    // its position; `socketQueued` prints at zero (a level of zero is a
    // reading), the other two only when they say something.
    ` socketQueued=${kb(window.queued.totalBytes)}kB` +
    (window.queued.unmeasured === 0 ? '' : ` socketQueuedUnmeasured=${window.queued.unmeasured}`) +
    (queuedTop.length === 0 ? '' : ` socketQueuedTop=${queuedTop}`) +
    // Last, and only from a registry that keeps the census: how many sibling
    // calls this parent forwarded opaquely against how many it decoded. A
    // `raw=0` under load is a failed negotiation, and nothing else shows it.
    (window.forward === undefined
      ? ''
      : ` socketFwd=${window.forward.raw}/${window.forward.decoded}`) +
    // Appended AFTER `socketFwd`, which was itself appended last for the same
    // reason (D446): every Loki prefix written since 2026-08-29 still matches
    // because no existing field moved. `socketActions` is the census grading
    // its own coverage and prints even at `0/0` — a census that named nothing
    // is a reading, and a missing field would be indistinguishable from a
    // registry that keeps no census at all. `socketTopActions` is conditional,
    // like `socketTop`: a ranked list of nothing is noise.
    (window.actions === undefined
      ? ''
      : ` socketActions=${kb(window.actions.labelledBytes)}/${kb(window.actions.totalBytes)}kB` +
        (window.actions.top.length === 0
          ? ''
          : ` socketTopActions=${window.actions.top.map(formatAction).join(',')}`))
  )
}
