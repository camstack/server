/**
 * array-buffer-census — WHAT SHAPE the live ArrayBuffers have, taken by the
 * heartbeat itself when they grow, because nobody can be awake for it.
 *
 * ## The episodes this exists for
 *
 * hub-main, 2026-09-10 (CEST): `arrayBuffers` climbed linearly and released in
 * one instant, twice, with not one line from the process at either boundary —
 * 17:26→18:31 at ~20 MB/min to 1 264 MB, released in one heartbeat; 22:20→23:36
 * at 60–85 MB/min to **4 968 MB**, released between two probes at 23:38. Both
 * were LIVE: a forced compacting GC at 23:36:40 returned 4 968→4 954 MB. The
 * measurement that names their shape had been prepared (D443) and was never
 * run, because it needed a human to run it during the episode, and the
 * episode does not wait. Two hours after the second release the process died
 * on `Ineffective mark-compacts near heap limit`.
 *
 * ## What this is, and what it is NOT
 *
 * `Runtime.queryObjects(ArrayBuffer.prototype)` over an IN-PROCESS inspector
 * session, followed by `Runtime.callFunctionOn` computing a byteLength
 * histogram over the result array, returned BY VALUE. It walks the heap in
 * memory and returns a few hundred bytes of JSON. Nothing is serialised,
 * nothing is written, no file exists afterwards.
 *
 * It is NOT a heap snapshot. `scripts/check-no-heap-dump-command.ts` forbids
 * `writeHeapSnapshot` because a multi-GB serialisation of the heap took the
 * whole host down twice; this module contains no such call and must never
 * grow one. The two look alike only in that both need a GC first.
 *
 * ## What it costs, and why the line says so
 *
 * `queryObjects` forces ONE full garbage collection before it walks — the same
 * stop-the-world the reclaim pass already pays every 10 minutes on this
 * process (~1 s at a 2.5 GB heap). The cost is printed on the line it
 * produces, because a pause with no owner in the log is exactly the kind of
 * stall D181 warns about on the process that mediates every cross-runner call.
 * The gate ({@link createArrayBufferCensusGate}) bounds it: a threshold, held
 * for a sustain window so a burst that dies in the next scavenge never pays,
 * and a generous cooldown so an hour-long episode buys a handful of readings,
 * not one per probe.
 *
 * ## Why the byteLength histogram, and not "who holds them"
 *
 * `queryObjects` returns the objects, not their retainers; a retainer walk is
 * a heap snapshot by another name. But the SIZE distribution already
 * discriminates the candidates that were argued about for a night: 65 536-byte
 * buffers are socket chunks, 8 192-byte ones are Buffer-pool slabs, a few
 * hundred equal multi-megabyte ones are frames or JPEGs, and the count says
 * whether it is thousands of small or dozens of huge. The exact top sizes are
 * printed as well as power-of-two buckets, because "1 462 272 B × 880" names
 * a producer where "≤2 MB: 1.2 GB" does not.
 */
import { Session } from 'node:inspector/promises'

/** One power-of-two bucket of the live set: every buffer with `byteLength <= upToBytes`
 *  and above the previous bucket. */
export interface ArrayBufferSizeBucket {
  readonly upToBytes: number
  readonly count: number
  readonly bytes: number
}

/** One exact byteLength and how much of the live set it accounts for. */
export interface ArrayBufferExactSize {
  readonly byteLength: number
  readonly count: number
  readonly bytes: number
}

export interface ArrayBufferCensusReport {
  /** Live `ArrayBuffer` objects reachable after the census's own GC. */
  readonly count: number
  /** Their total `byteLength`. */
  readonly bytes: number
  /** Buffers whose backing store is gone (`byteLength === 0`, detached). */
  readonly detached: number
  /** Largest buckets first, by bytes. */
  readonly buckets: readonly ArrayBufferSizeBucket[]
  /** Largest exact sizes first, by bytes. */
  readonly topSizes: readonly ArrayBufferExactSize[]
}

/** Take a census. Injectable so the heartbeat's gating is testable without an inspector. */
export type ArrayBufferCensus = () => Promise<ArrayBufferCensusReport>

/**
 * Take the census once `arrayBuffers` has been at or above this for
 * {@link ARRAY_BUFFER_CENSUS_SUSTAIN_MS}.
 *
 * 512 MB. The two 2026-09-10 episodes crossed it 25 and 8 minutes in; the
 * routine reading in six hours of 2-second samples around them was 18–100 MB
 * with single-sample spikes to 479 MB, and the process's floor after every
 * compaction is 12–18 MB. A dead-buffer sawtooth between major GCs (measured
 * up to 3.65 GB on 2026-08-08 when the heap had 4 GB of headroom) cannot reach
 * it while GC runs every few seconds — and if one did, the census would SAY
 * so: it reports the live total after its own GC next to the raw reading.
 */
export const ARRAY_BUFFER_CENSUS_THRESHOLD_MB = 512

/**
 * How long the reading must stay above the threshold before a census is taken.
 *
 * 60 s = 30 probes at the 2 s cadence. A burst that a scavenge or the next
 * major GC returns never pays a forced GC; an episode climbing at the slowest
 * rate measured (20 MB/min) is still 20 MB higher by the time it is measured,
 * which is nothing against the threshold.
 */
export const ARRAY_BUFFER_CENSUS_SUSTAIN_MS = 60_000

/**
 * Minimum spacing between two censuses.
 *
 * 30 minutes: the second episode ran 76 minutes, so it would have produced
 * three readings — enough to see the shape change (or not) as it grew — at a
 * cost the router already pays six times an hour for the reclaim pass.
 */
export const ARRAY_BUFFER_CENSUS_COOLDOWN_MS: number = 30 * 60_000

/**
 * A drop of at least this share of the threshold between two consecutive
 * probes, from a reading that had been SUSTAINED above the threshold, is a
 * RELEASE — the boundary both episodes crossed with no line, and the one line
 * that lets the release be correlated with whatever else the process logged
 * that second. Sustained, not merely above: a one-probe spike that the next
 * scavenge sweeps (a 1.3 GB burst in 11 s was measured on 2026-08-29) is not
 * an episode ending, and a WARN for every one of those would bury the line
 * this exists to produce.
 */
export const ARRAY_BUFFER_RELEASE_MIN_DROP_RATIO = 0.5

export interface ArrayBufferCensusGateOptions {
  readonly thresholdMb?: number
  readonly sustainMs?: number
  readonly cooldownMs?: number
}

/** What one probe reading means to the gate. */
export type ArrayBufferCensusVerdict =
  | { readonly kind: 'hold' }
  /** Take a census now. `reason` is printed on the resulting line. */
  | { readonly kind: 'take'; readonly reason: string }
  /** The live set was released between this probe and the previous one. */
  | { readonly kind: 'released'; readonly fromMb: number; readonly toMb: number }

export interface ArrayBufferCensusGate {
  /** Judge one reading. A `take` verdict starts the cooldown. */
  readonly observe: (arrayBuffersMb: number, at: number) => ArrayBufferCensusVerdict
}

/**
 * The pure decision: threshold, sustain, cooldown, release — testable without
 * allocating a gigabyte or forcing a GC.
 */
export function createArrayBufferCensusGate(
  options: ArrayBufferCensusGateOptions = {},
): ArrayBufferCensusGate {
  const thresholdMb = options.thresholdMb ?? ARRAY_BUFFER_CENSUS_THRESHOLD_MB
  const sustainMs = options.sustainMs ?? ARRAY_BUFFER_CENSUS_SUSTAIN_MS
  const cooldownMs = options.cooldownMs ?? ARRAY_BUFFER_CENSUS_COOLDOWN_MS
  let aboveSince: number | null = null
  let lastTakenAt = Number.NEGATIVE_INFINITY
  let previousMb: number | null = null
  let previousAt: number | null = null

  return {
    observe(arrayBuffersMb, at) {
      const previous = previousMb
      const previousHeldForMs =
        previous !== null && previousAt !== null && aboveSince !== null
          ? previousAt - aboveSince
          : null
      previousMb = arrayBuffersMb
      previousAt = at
      if (
        previous !== null &&
        previousHeldForMs !== null &&
        previousHeldForMs >= sustainMs &&
        previous - arrayBuffersMb >= thresholdMb * ARRAY_BUFFER_RELEASE_MIN_DROP_RATIO
      ) {
        aboveSince = null
        return { kind: 'released', fromMb: previous, toMb: arrayBuffersMb }
      }
      if (arrayBuffersMb < thresholdMb) {
        aboveSince = null
        return { kind: 'hold' }
      }
      aboveSince ??= at
      const heldForMs = at - aboveSince
      if (heldForMs < sustainMs) return { kind: 'hold' }
      if (at - lastTakenAt < cooldownMs) return { kind: 'hold' }
      lastTakenAt = at
      return {
        kind: 'take',
        reason: `arrayBuffers=${arrayBuffersMb}MB has been >=${thresholdMb}MB for ${heldForMs}ms`,
      }
    },
  }
}

/** Buckets printed on the line. More than this and the line stops being readable. */
const REPORT_BUCKETS = 6
/** Exact sizes printed on the line. */
const REPORT_TOP_SIZES = 5

/**
 * The function evaluated INSIDE the inspector against the `queryObjects`
 * result array (`this`). Kept as source text because that is what the
 * protocol takes; kept small because it runs with the world stopped.
 */
const HISTOGRAM_FN = `function () {
  var byBucket = new Map(), bySize = new Map()
  var count = 0, bytes = 0, detached = 0
  for (var i = 0; i < this.length; i++) {
    var b = this[i].byteLength
    count++
    bytes += b
    if (b === 0) { detached++; continue }
    var bucket = 1
    while (bucket < b) bucket *= 2
    var e = byBucket.get(bucket); if (!e) { e = [0, 0]; byBucket.set(bucket, e) }
    e[0]++; e[1] += b
    var s = bySize.get(b); if (!s) { s = [0, 0]; bySize.set(b, s) }
    s[0]++; s[1] += b
  }
  var buckets = []
  byBucket.forEach(function (v, k) { buckets.push({ upToBytes: k, count: v[0], bytes: v[1] }) })
  buckets.sort(function (a, b) { return b.bytes - a.bytes })
  var topSizes = []
  bySize.forEach(function (v, k) { topSizes.push({ byteLength: k, count: v[0], bytes: v[1] }) })
  topSizes.sort(function (a, b) { return b.bytes - a.bytes })
  return { count: count, bytes: bytes, detached: detached,
    buckets: buckets.slice(0, ${REPORT_BUCKETS}), topSizes: topSizes.slice(0, ${REPORT_TOP_SIZES}) }
}`

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isBucket(value: unknown): value is ArrayBufferSizeBucket {
  return (
    typeof value === 'object' &&
    value !== null &&
    isFiniteNumber(Reflect.get(value, 'upToBytes')) &&
    isFiniteNumber(Reflect.get(value, 'count')) &&
    isFiniteNumber(Reflect.get(value, 'bytes'))
  )
}

function isExactSize(value: unknown): value is ArrayBufferExactSize {
  return (
    typeof value === 'object' &&
    value !== null &&
    isFiniteNumber(Reflect.get(value, 'byteLength')) &&
    isFiniteNumber(Reflect.get(value, 'count')) &&
    isFiniteNumber(Reflect.get(value, 'bytes'))
  )
}

/** The inspector answers `unknown`; the report is trusted only once it has this shape. */
export function isArrayBufferCensusReport(value: unknown): value is ArrayBufferCensusReport {
  if (typeof value !== 'object' || value === null) return false
  const buckets: unknown = Reflect.get(value, 'buckets')
  const topSizes: unknown = Reflect.get(value, 'topSizes')
  return (
    isFiniteNumber(Reflect.get(value, 'count')) &&
    isFiniteNumber(Reflect.get(value, 'bytes')) &&
    isFiniteNumber(Reflect.get(value, 'detached')) &&
    Array.isArray(buckets) &&
    buckets.every(isBucket) &&
    Array.isArray(topSizes) &&
    topSizes.every(isExactSize)
  )
}

function readObjectId(result: unknown, path: readonly string[]): string {
  let cursor: unknown = result
  for (const key of path) {
    if (typeof cursor !== 'object' || cursor === null) {
      throw new Error(`inspector reply has no ${path.join('.')}`)
    }
    cursor = Reflect.get(cursor, key)
  }
  if (typeof cursor !== 'string') throw new Error(`inspector reply has no ${path.join('.')}`)
  return cursor
}

/**
 * The real census: an in-process inspector session, opened for the call and
 * closed after it, so no session is left listening between censuses.
 *
 * Every remote object it creates is released before the session closes; a
 * failure anywhere still disconnects. The session is in-process — nothing
 * listens on a port, nothing outside this process can reach it.
 */
export function createInspectorArrayBufferCensus(): ArrayBufferCensus {
  return async () => {
    const session = new Session()
    session.connect()
    try {
      const proto: unknown = await session.post('Runtime.evaluate', {
        expression: 'ArrayBuffer.prototype',
      })
      const prototypeObjectId = readObjectId(proto, ['result', 'objectId'])
      try {
        // This is the forced GC + heap walk. In memory; nothing serialised.
        const query: unknown = await session.post('Runtime.queryObjects', { prototypeObjectId })
        const objectId = readObjectId(query, ['objects', 'objectId'])
        try {
          const evaluated: unknown = await session.post('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: HISTOGRAM_FN,
            returnByValue: true,
          })
          const value: unknown =
            typeof evaluated === 'object' && evaluated !== null
              ? Reflect.get(Reflect.get(evaluated, 'result') ?? {}, 'value')
              : undefined
          if (!isArrayBufferCensusReport(value)) {
            throw new Error('inspector returned a histogram of an unexpected shape')
          }
          return value
        } finally {
          await session.post('Runtime.releaseObject', { objectId })
        }
      } finally {
        await session.post('Runtime.releaseObject', { objectId: prototypeObjectId })
      }
    } finally {
      session.disconnect()
    }
  }
}

const MB = 1048576

function mb(bytes: number): number {
  return Math.round(bytes / MB)
}

function formatBucket(bucket: ArrayBufferSizeBucket): string {
  const label =
    bucket.upToBytes >= MB
      ? `${Math.round(bucket.upToBytes / MB)}MB`
      : bucket.upToBytes >= 1024
        ? `${Math.round(bucket.upToBytes / 1024)}KB`
        : `${bucket.upToBytes}B`
  return `<=${label}:${bucket.count}x/${mb(bucket.bytes)}MB`
}

function formatExact(size: ArrayBufferExactSize): string {
  return `${size.byteLength}Bx${size.count}=${mb(size.bytes)}MB`
}

/** What a census line needs beyond the report. */
export interface ArrayBufferCensusContext {
  /** `process.memoryUsage().arrayBuffers` at the probe that triggered it. */
  readonly rawMb: number
  readonly tookMs: number
  /** The gate's `take` reason. */
  readonly reason: string
}

/**
 * The census line. `live` is what survived the census's own GC; `raw` is the
 * reading that triggered it — when they disagree by a lot, the growth was dead
 * buffers awaiting a sweep, not a retention, and the line says which.
 */
export function formatArrayBufferCensus(
  label: string,
  report: ArrayBufferCensusReport,
  context: ArrayBufferCensusContext,
): string {
  const live = mb(report.bytes)
  const verdict =
    live < context.rawMb * ARRAY_BUFFER_RELEASE_MIN_DROP_RATIO
      ? 'mostly DEAD buffers awaiting a sweep, not a retention'
      : 'LIVE — something holds them'
  return (
    `[mem] ${label} arrayBuffer census: live=${live}MB in ${report.count} ArrayBuffers ` +
    `(raw arrayBuffers=${context.rawMb}MB at the trigger → ${verdict}) ` +
    `top sizes: ${report.topSizes.map(formatExact).join(', ') || '(none)'}; ` +
    `buckets: ${report.buckets.map(formatBucket).join(', ') || '(none)'}; ` +
    `detached=${report.detached} took=${context.tookMs}ms — ` +
    `cost: ONE forced full GC (the same pause as a reclaim pass), walked in memory, ` +
    `nothing serialised, nothing written; trigger: ${context.reason}`
  )
}
