/**
 * socket-traffic — per-channel byte and message counters, split by frame kind.
 *
 * ## The question this exists to answer
 *
 * hub-main runs ~22 000 socket reads/s and ~22 500 writes/s at a **0.33 KB
 * mean** (measured 2026-08-29 from `/proc/<pid>/io` with every regular-file
 * descriptor's offset subtracted, so the bytes are socket bytes and not file
 * bytes). That is ~44 000 syscalls/s on the process that mediates every
 * cross-runner call, and **nothing could attribute a single one of them**. The
 * event fan-out plane WAS measurable — `LocalChildRegistry` has counted
 * `sent`/`suppressed` per child since the gate was built — and once surfaced it
 * accounted for **4 %**. The other 96 % had no instrument at all.
 *
 * `/proc` cannot close this: it reports one `rchar`/`wchar` pair for the whole
 * process, and per-socket counters do not exist there. The correlation that was
 * available — 78–82 % of hub-main's outbound bytes moving with
 * `hub/pipeline-analytics` — is derived from that runner's own `rchar`, which
 * also counts page-cache file reads on a runner that owns a vector store. It is
 * a correlation and it has never been an attribution.
 *
 * So the counters have to sit where the frames are: in the channel, on both
 * sides, split by kind.
 *
 * ## Why split by KIND, and why these three
 *
 * A total answers nothing that was not already known. The three wire kinds are
 * three different mechanisms with three different fixes:
 *
 *  - `req` — a cap call this process is making or serving. Scales with work.
 *  - `res` — its answer. Where a payload can be large (a msgpack `Uint8Array`
 *    of GOP bytes is a `res`), so this is the field the "message-RATE, not
 *    media" conclusion is falsified against: if `res` bytes dominate at a large
 *    mean, the traffic is media and D9/D18 must be re-opened.
 *  - `evt` — one-way fan-out. Scales with the number of runners rather than
 *    with anything an operator asked for; an IDLE addon still reads 82
 *    messages/s of it.
 *
 * Bytes AND messages, per kind, because the mean is the whole argument: 0.33 KB
 * across 22 000 reads/s is a rate problem, and the same bytes in 300 messages
 * would be a media problem.
 *
 * ## Why these objects are MUTATED
 *
 * A deliberate, measured exception to the immutability default. The write
 * happens on a path that runs ~44 000 times a second; allocating a replacement
 * object per frame would make the instrument the largest allocator it is trying
 * to measure. The counters are therefore plain mutable numbers, written only by
 * {@link recordSocketFrame} and read only through {@link sampleSocketDirection},
 * which copies. Same discipline `LocalChildRegistry` already applies to
 * `childEventStats`.
 *
 * Cumulative for the life of the channel. A cumulative number on a heartbeat
 * answers "how much since boot", which nobody asked; the reporting layer
 * (`kernel/socket-plane-report.ts`) subtracts the previous reading and reports
 * the window, exactly as the fan-out counters and the loop-delay histogram do.
 */

/** The three wire kinds of {@link import('./local-transport.js').Frame}. */
export type SocketMessageKind = 'req' | 'res' | 'evt'

/**
 * One direction of one channel, cumulative. Mutable by design — see the module
 * docblock; nothing outside {@link recordSocketFrame} may write these.
 *
 * `bytes` is the ON-THE-WIRE size: the 4-byte length prefix plus the MsgPack
 * body, i.e. exactly what `socket.write` was handed and exactly what the peer's
 * `rchar` will have counted. Anything else would not reconcile against `/proc`,
 * and reconciling against `/proc` is the only reason to trust either number.
 */
export interface SocketDirectionCounters {
  reqMessages: number
  reqBytes: number
  resMessages: number
  resBytes: number
  evtMessages: number
  evtBytes: number
}

/** An immutable reading of {@link SocketDirectionCounters}. */
export interface SocketDirectionSample {
  readonly reqMessages: number
  readonly reqBytes: number
  readonly resMessages: number
  readonly resBytes: number
  readonly evtMessages: number
  readonly evtBytes: number
}

/** Both directions of one channel. */
export interface SocketTrafficSample {
  /** Frames this process WROTE to the peer. */
  readonly tx: SocketDirectionSample
  /** Frames this process READ from the peer. */
  readonly rx: SocketDirectionSample
}

export function createSocketDirectionCounters(): SocketDirectionCounters {
  return { reqMessages: 0, reqBytes: 0, resMessages: 0, resBytes: 0, evtMessages: 0, evtBytes: 0 }
}

/**
 * The hot-path write. Two additions and at most two string comparisons against
 * interned literals — no allocation, no branch on anything the caller has to
 * compute, and nothing that can throw.
 *
 * Measured on Node 24.17, 20 M iterations, three runs: **2.37–2.41 ns/call**
 * against an empty loop. Its neighbours on the same path, measured in the same
 * run: `encodeFrame` on a 0.33 KB body 1948–1975 ns, `FrameDecoder.push`
 * 1156–1166 ns, `process.memoryUsage()` 920–945 ns. The counter is **0.12 % of
 * `encodeFrame`** — and `encodeFrame` is followed by a syscall.
 *
 * Together with the decoder's per-frame size write (0.06–0.13 ns, see
 * `frame-codec.ts`) the whole instrument adds **~2.5 ns per frame**: at 44 000
 * frames/s that is 107–111 µs/s, i.e. **0.011 % of one core**. An instrument
 * that changes what it measures is not an instrument, and this one cannot.
 */
export function recordSocketFrame(
  counters: SocketDirectionCounters,
  kind: SocketMessageKind,
  bytes: number,
): void {
  if (kind === 'evt') {
    // First, because it is the majority kind on every plane measured so far.
    counters.evtMessages += 1
    counters.evtBytes += bytes
    return
  }
  if (kind === 'req') {
    counters.reqMessages += 1
    counters.reqBytes += bytes
    return
  }
  counters.resMessages += 1
  counters.resBytes += bytes
}

/** Copy out. Called once per heartbeat line, never on the frame path. */
export function sampleSocketDirection(counters: SocketDirectionCounters): SocketDirectionSample {
  return {
    reqMessages: counters.reqMessages,
    reqBytes: counters.reqBytes,
    resMessages: counters.resMessages,
    resBytes: counters.resBytes,
    evtMessages: counters.evtMessages,
    evtBytes: counters.evtBytes,
  }
}

/** A direction that has seen nothing. */
export const EMPTY_SOCKET_DIRECTION: SocketDirectionSample = {
  reqMessages: 0,
  reqBytes: 0,
  resMessages: 0,
  resBytes: 0,
  evtMessages: 0,
  evtBytes: 0,
}

/** Total messages across the three kinds. */
export function socketDirectionMessages(sample: SocketDirectionSample): number {
  return sample.reqMessages + sample.resMessages + sample.evtMessages
}

/** Total on-the-wire bytes across the three kinds. */
export function socketDirectionBytes(sample: SocketDirectionSample): number {
  return sample.reqBytes + sample.resBytes + sample.evtBytes
}
