/**
 * Which CALL SITE reads the whole fleet — measured, never inferred.
 *
 * ## The number this exists to explain
 *
 * The sqlite profiler measured `query device-manager:devices`, shape
 * `SELECT … ORDER BY "deviceId" ASC LIMIT ?`, at **4 149 calls and 4 219 533
 * rows in one 66-second boot window** (2026-08-25). Steady state is 39/min. The
 * comment in `device-queries.ts#listAll` has said "~3 000 for a 974-device boot"
 * for weeks and names nobody, because the engine reports an
 * `(op, collection, shape)` tuple — a statement, not a caller.
 *
 * Two candidates were read and EXCLUDED by hand: `device-manager.addon.ts`'s
 * `idToAddonId` warm and `device-bindings-store.ts`'s `getAllBindings`. Both are
 * boot one-shots. Picking the next most plausible reader is exactly what this
 * repo did twice in one afternoon and got wrong twice, at half a day each. An
 * attribution is a measurement or it is a guess.
 *
 * ## Why an env var, and not a `debug.*` action
 *
 * `pipeline-analytics`'s {@link StoreReadCensus} is armed through a custom
 * action, which is the right shape for a steady-state mystery: you notice, you
 * arm, you read. It cannot work here. **The storm is at BOOT** — by the time a
 * process is up enough to receive an action, the window being investigated has
 * closed. So this arms at CONSTRUCTION from `CAMSTACK_FLEET_READ_CENSUS_MS` and
 * closes itself after that many milliseconds.
 *
 * A bad value **disarms**. An env var someone fat-fingered must not quietly
 * install a stack capture on the fleet-read path until the next container
 * recreation.
 *
 * ## Why it reports through the logger
 *
 * The hub's in-memory log ring holds roughly 35 minutes. A boot measurement
 * asked about an hour later is simply gone — that is what turned the
 * native-capture question into an UNKNOWN until Loki was used instead. A logged
 * report lands in Loki, which carries 12 h and more.
 */

import type { IScopedLogger } from '@camstack/types'

/** How many stack frames identify a call site. One frame is a method; three are
 *  a cause — `listFleet < listAll < onDeviceRegistered` is the answer, `listAll`
 *  alone is not. Same choice, for the same reason, as `read-census.ts`. */
const CENSUS_STACK_FRAMES = 3

/** One attributed call site. */
export interface FleetCensusRow {
  readonly site: string
  readonly calls: number
  readonly rows: number
}

/** Internal accumulator — mutable, never handed out. */
interface Counter {
  site: string
  calls: number
  rows: number
}

function siteFromStack(stack: string | undefined): string {
  if (stack === undefined) return 'unknown'
  const frames = stack
    .split('\n')
    .slice(1)
    .map((line) => line.trim().replace(/^at\s+/, ''))
    .filter((line) => line.length > 0)
    .slice(0, CENSUS_STACK_FRAMES)
    .map((line) => {
      // Keep the function identity, drop the absolute path — a site must be
      // comparable across two processes and two machines.
      const open = line.indexOf(' (')
      const name = open > 0 ? line.slice(0, open) : line
      return name.replace(/^async\s+/, '')
    })
  return frames.length === 0 ? 'unknown' : frames.join(' < ')
}

export class FleetReadCensus {
  /**
   * Longest window the census may be armed for.
   *
   * Ten minutes covers a boot several times over and bounds what an operator
   * pays if they set the variable and forget it. A diagnostic that can be left
   * on becomes a tax nobody remembers enabling.
   */
  static readonly MAX_WINDOW_MS: number = 10 * 60_000

  readonly windowMs: number
  private readonly closesAt: number
  private readonly counts = new Map<string, Counter>()
  private reported = false

  constructor(rawEnv: string | undefined, nowMs: number) {
    const parsed = rawEnv === undefined ? Number.NaN : Number(rawEnv)
    const valid = Number.isFinite(parsed) && parsed > 0
    this.windowMs = valid ? Math.min(parsed, FleetReadCensus.MAX_WINDOW_MS) : 0
    this.closesAt = valid ? nowMs + this.windowMs : 0
  }

  get armed(): boolean {
    return this.windowMs > 0
  }

  /** Test seam: pretend the window closed. Production reads the clock. */
  closeAt(nowMs: number): void {
    if (nowMs >= this.closesAt) this.forceClosed = true
  }

  private forceClosed = false

  private isOpen(nowMs: number): boolean {
    if (!this.armed || this.forceClosed) return false
    return nowMs < this.closesAt
  }

  /**
   * Capture the caller, or `null` when the window is shut.
   *
   * Called at the START of a read. A read that began inside the window belongs
   * to it even if it lands after the close — otherwise the slow reads at the
   * edge would be attributed to nobody, and the slow ones are the interesting
   * ones.
   *
   * `callerAddonId`, when given, is formatted as the site VERBATIM instead of
   * walking the local stack. A call that arrived over the cap channel — a
   * forked addon's `ctx.api.deviceManager.listAll.query()`, routed through
   * `LocalChildRegistry` → `onUnownedCall` → `CapRouteResolver` — carries its
   * origin as DATA (the registered `childId` the parent captured off the UDS
   * connection), and no amount of stack depth would ever recover it: every
   * frame between the socket read and this call is the SAME generic
   * dispatcher code (`onUnownedCall`, `dispatch`, `invoke`) regardless of
   * which addon called — the 2026-08-25 boot census measured this directly,
   * five thousand calls landing on `listAll` with nothing nameable above it.
   *
   * `isOpen` is checked FIRST, before the id is even looked at — a caller
   * threading a (cheap, already-known) `callerAddonId` through on every
   * request, armed or not, must not pay for the template string when
   * disarmed. This is also why formatting lives HERE rather than at the call
   * site: `DeviceRowStore` passes the raw id through unconditionally, and
   * only this method — which already knows whether armed — decides whether
   * to spend anything on it.
   */
  siteOf(callerAddonId?: string, nowMs: number = Date.now()): string | null {
    if (!this.isOpen(nowMs)) return null
    if (callerAddonId !== undefined) return `addon:${callerAddonId}`
    const holder: { stack?: string } = {}
    Error.captureStackTrace(holder, this.siteOf)
    return siteFromStack(holder.stack)
  }

  /** Count one read at an already-captured site. A `null` site is not counted. */
  record(site: string | null, rowCount: number): void {
    if (site === null) return
    const existing = this.counts.get(site)
    if (existing === undefined) {
      this.counts.set(site, { site, calls: 1, rows: rowCount })
      return
    }
    existing.calls += 1
    existing.rows += rowCount
  }

  /** Attributed sites, busiest first. */
  rows(): readonly FleetCensusRow[] {
    return [...this.counts.values()]
      .map((c): FleetCensusRow => ({ site: c.site, calls: c.calls, rows: c.rows }))
      .sort((a, b) => b.calls - a.calls)
  }

  /**
   * Emit the report ONCE.
   *
   * `perMin` is included because the raw count is unreadable without the window
   * it was taken over — "4 149" means nothing until you know it was 66 seconds.
   */
  report(logger: IScopedLogger, elapsedMs: number): void {
    if (this.reported || !this.armed) return
    this.reported = true
    const rows = this.rows()
    const totalCalls = rows.reduce((acc, r) => acc + r.calls, 0)
    logger.info('fleet read census', {
      meta: {
        elapsedMs,
        sites: rows.length,
        totalCalls,
        rows: rows.map((r) => ({
          site: r.site,
          calls: r.calls,
          rows: r.rows,
          perMin: elapsedMs === 0 ? 0 : Math.round((r.calls * 60_000) / elapsedMs),
        })),
      },
    })
  }
}
