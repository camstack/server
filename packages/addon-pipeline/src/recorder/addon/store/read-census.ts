/**
 * Which CALL SITE issued a `recorder:recording-configs` / `-exports` /
 * `-ops-log` row read - measured, never inferred.
 *
 * ## Why this exists
 *
 * The live-hub profiler names a table and a statement: on 2026-08-26 a 60 s
 * window read `get recorder:recording-configs` 581-892 times a minute and
 * found a row only ~56% of the time - several hundred times a minute the
 * recorder asks the disk whether a camera has a config and the answer is no.
 * The profiler cannot say WHICH of `loadDeviceConfig` / `readDeviceConfigs`'s
 * four call sites (`getStatus`, `getDeviceConfig`, `rescanStorage`,
 * `pruneFootage` in `recording-provider.ts`) is issuing them - a settings-store
 * `get` receives a collection and a key, not a caller.
 *
 * The alternative is reading the code and picking the reader that LOOKS like a
 * loop. That has cost this repo half a day twice, wrong both times (see the
 * sibling module this one is ported from,
 * `addon-post-analysis/src/pipeline-analytics/store/read-census.ts`). So the
 * rule for this work is the same: an attribution is a measurement or it is a
 * guess, and a guess gets acted on.
 *
 * ## What it measures
 *
 * Every read through the recorder's censused settings-store client -
 * `configStore()` / `exportsStore()` / `opsLogStore()` in `index.ts` - keyed by
 * the top frames of the JavaScript stack at the moment of the call. Three
 * frames are kept because one is rarely enough to act on: `RowMapStore.read`
 * is a method, `loadDeviceConfig < getStatus` is a cap handler.
 *
 * ## Why it is armed rather than always on
 *
 * Capturing a stack costs microseconds; at several hundred reads/minute that
 * is real. So the census is armed for a bounded window through the
 * `debug.storeCensus` action and disarms itself - a diagnostic that can be
 * left on becomes a tax nobody remembers enabling.
 *
 * What stays wired permanently is the PROXY, which costs one `get` trap per
 * read and, unlike an env var, needs neither a container recreation nor a
 * redeploy to use. The next time this addon's read volume regresses, "who?" is
 * one action call away instead of one release away.
 */

import type { IScopedLogger } from '@camstack/types'

/** How many stack frames identify a call site. See the module doc. */
export const CENSUS_STACK_FRAMES = 3

/**
 * Longest window the census may be armed for, in ms.
 *
 * Ten minutes is several report windows - enough to catch a sweep that fires
 * every few minutes - and short enough that an operator who forgets about it
 * pays for ten minutes, not until the next restart.
 */
export const CENSUS_MAX_WINDOW_MS = 10 * 60_000

/** Store procedures worth attributing. Reads only: a write is an operator
 *  gesture or a pipeline product, and neither is a mystery. */
const CENSUSED_PROCEDURES: ReadonlySet<string> = new Set([
  'query',
  'count',
  'aggregate',
  'get',
  'histogram',
  'getAll',
])

/** One `(op, site)` tuple's totals. `rows` is what the reads RETURNED - the
 *  number that separates a hot loop from a loop that finds nothing. */
export interface StoreCensusRow {
  readonly op: string
  readonly site: string
  readonly calls: number
  readonly rows: number
}

interface MutableCensusRow {
  readonly op: string
  readonly site: string
  calls: number
  rows: number
}

type NowFn = () => number

/**
 * The function whose frame - and everything above it - is cut off a captured
 * stack. Always the wrapper doing the capturing.
 */
type StackCutoff = (...args: never[]) => unknown

/**
 * Can `new Proxy` wrap this, and is it worth wrapping?
 *
 * Functions count. The generated store client is a **tRPC proxy** and every
 * intermediate node of one is CALLABLE — `typeof client.query` is `'function'`,
 * not `'object'`. A wrapper that tested only for `'object'` handed the whole
 * client back unwrapped, deployed, and reported zero `query` and zero `count`
 * call sites while the engine was recording thousands a minute against the same
 * tables. Silence read as "nobody in this addon does it".
 */
function isProxyable(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function rowsOf(value: unknown): number {
  if (Array.isArray(value)) return value.length
  if (typeof value === 'number') return value
  if (value === undefined || value === null) return 0
  return 1
}

/**
 * One V8 stack line reduced to `Function@line`.
 *
 * A deployed addon is ONE bundled file, so the path is identical on every frame
 * and carries no information; the line number does. A frame that parses as
 * neither keeps its trimmed text rather than being dropped - an unrecognised
 * frame is still an attribution, and dropping it would silently shift the site
 * one frame up.
 */
export function compactFrame(line: string): string {
  const trimmed = line.trim().replace(/^at\s+/, '')
  const named = /^(.+?)\s+\((?:.*?):(\d+):\d+\)$/.exec(trimmed)
  if (named !== null) return `${named[1]}@${named[2]}`
  const bare = /^(?:.*?):(\d+):\d+$/.exec(trimmed)
  if (bare !== null) return `@${bare[1]}`
  return trimmed
}

/** The census's view of a stack: the top {@link CENSUS_STACK_FRAMES} frames,
 *  innermost first, joined by ` < ` so a line reads caller-ward. */
export function siteFromStack(stack: string | undefined): string {
  if (stack === undefined) return 'unknown'
  const frames = stack.split('\n').slice(1, 1 + CENSUS_STACK_FRAMES)
  if (frames.length === 0) return 'unknown'
  return frames.map(compactFrame).join(' < ')
}

/**
 * Armed-window call-site counter.
 *
 * Disarmed it is one comparison per read and captures nothing - the stack is
 * the whole cost, and it is not taken.
 */
export class StoreReadCensus {
  private readonly counts = new Map<string, MutableCensusRow>()
  private armedUntil = 0
  private armedAt = 0

  constructor(private readonly now: NowFn = () => Date.now()) {}

  /** Arm for `forMs`, clamped to {@link CENSUS_MAX_WINDOW_MS}. Re-arming
   *  restarts the window and CLEARS the counts: two overlapping measurements in
   *  one table is a table nobody can divide by a duration. */
  arm(forMs: number): void {
    const at = this.now()
    this.counts.clear()
    this.armedAt = at
    this.armedUntil = at + Math.max(0, Math.min(forMs, CENSUS_MAX_WINDOW_MS))
  }

  disarm(): void {
    this.armedUntil = 0
  }

  get armed(): boolean {
    return this.now() < this.armedUntil
  }

  /** How long the current (or just-finished) window collected, in ms. The
   *  divisor for a calls-per-minute rate - a count without it is a number that
   *  cannot be compared to the next one. */
  elapsedMs(): number {
    const at = this.now()
    return Math.max(0, Math.min(at, this.armedUntil) - this.armedAt)
  }

  /**
   * The call site of whoever called `cutoff`, or `null` when disarmed.
   *
   * **Taken BEFORE the await, always.** The first version of this class
   * captured the stack next to the counter, after the wrapped call had
   * resolved - and by then the synchronous caller is gone: V8 stitches an async
   * frame in its place and the site reads
   * `Proxy.<anonymous> < processTicksAndRejections`, which is the census
   * describing itself. It passed one of its own tests anyway, because that one
   * caller happened to RETURN the promise rather than await it. An instrument
   * that reports its own frames is worse than no instrument: the counts are
   * real, so the wrong name gets believed.
   *
   * `cutoff` is the wrapper function itself, so every frame from the wrapper
   * inwards is dropped and frame 0 is the code that asked.
   */
  siteOf(cutoff: StackCutoff): string | null {
    if (!this.armed) return null
    const holder: { stack?: string } = {}
    Error.captureStackTrace(holder, cutoff)
    return siteFromStack(holder.stack)
  }

  /**
   * Count one read at an already-captured site.
   *
   * A `null` site means the census was disarmed when the call STARTED. It is
   * not counted even if it lands inside a later window - a read belongs to the
   * window that issued it.
   */
  record(op: string, site: string | null, result: unknown): void {
    if (site === null) return
    const key = `${op} ${site}`
    const existing = this.counts.get(key)
    if (existing === undefined) {
      this.counts.set(key, { op, site, calls: 1, rows: rowsOf(result) })
      return
    }
    existing.calls += 1
    existing.rows += rowsOf(result)
  }

  /** Busiest first. Does NOT clear - a window may be read as many times as the
   *  operator likes and always describes the same window. */
  rows(): readonly StoreCensusRow[] {
    return [...this.counts.values()]
      .map((r) => ({ op: r.op, site: r.site, calls: r.calls, rows: r.rows }))
      .sort((a, b) => b.calls - a.calls)
  }
}

/**
 * Wrap a settings-store client so every read is counted.
 *
 * A `Proxy` over the generated tRPC client rather than a hand-written facade:
 * the client has a procedure per cap method and a facade would need updating
 * every time the cap gains one - which is how a diagnostic quietly stops seeing
 * half the traffic. Unrecognised procedures pass straight through.
 */
export function censusStoreClient<TClient extends object>(
  client: TClient,
  census: StoreReadCensus,
): TClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const procedure = Reflect.get(target, prop, receiver)
      if (typeof prop !== 'string' || !CENSUSED_PROCEDURES.has(prop)) return procedure
      if (!isProxyable(procedure)) return procedure
      const op = prop
      return new Proxy(procedure, {
        get(procTarget, procProp, procReceiver) {
          const call = Reflect.get(procTarget, procProp, procReceiver)
          if (procProp !== 'query' && procProp !== 'mutate') return call
          if (typeof call !== 'function') return call
          const wrapped = async (...args: readonly unknown[]): Promise<unknown> => {
            const site = census.siteOf(wrapped)
            const result = await Reflect.apply(call, procTarget, args)
            census.record(op, site, result)
            return result
          }
          return wrapped
        },
      })
    },
  })
}

/**
 * Wrap `ctx.api` so `ctx.api.settingsStore` hands out a censused client.
 *
 * The seam is the API object rather than every place that reads
 * `api.settingsStore` off it: an instrument installed at each call site is an
 * instrument that will be installed at N-1 after the next feature, and the
 * read it stops seeing is the one worth seeing.
 *
 * The wrapped client is memoised, so identity comparisons across the addon
 * still hold.
 */
export function censusApi<TApi extends object>(api: TApi, census: StoreReadCensus): TApi {
  let wrappedStore: unknown
  return new Proxy(api, {
    get(target, prop, receiver) {
      const member = Reflect.get(target, prop, receiver)
      if (prop !== 'settingsStore') return member
      if (!isProxyable(member)) return member
      wrappedStore ??= censusStoreClient(member, census)
      return wrappedStore
    },
  })
}

/** Log the census as one line, including when it collected nothing - silence
 *  after an arm is indistinguishable from a census that never armed. */
export function logCensus(
  census: StoreReadCensus,
  logger: IScopedLogger,
  topN: number,
): readonly StoreCensusRow[] {
  const rows = census.rows()
  const elapsedMs = census.elapsedMs()
  const perMin = (calls: number): number =>
    elapsedMs === 0 ? 0 : Math.round((calls * 60_000) / elapsedMs)
  logger.info('store read census', {
    meta: {
      elapsedMs,
      sites: rows.length,
      calls: rows.reduce((acc, r) => acc + r.calls, 0),
      top: rows.slice(0, topN).map((r) => ({
        op: r.op,
        site: r.site,
        calls: r.calls,
        perMin: perMin(r.calls),
        rows: r.rows,
      })),
    },
  })
  return rows
}
