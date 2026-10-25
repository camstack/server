/**
 * WHO is calling the hub, and OVER WHICH PLANE - measured at the transport,
 * never inferred.
 *
 * ## Three planes, and a named bucket for the fourth case
 *
 * The file is still called `http-request-census` and the persisted row is still
 * `http-request-census`, because renaming a settings key to improve a noun is
 * how a diagnostic silently stops restoring across the release that renamed it.
 * The INSTRUMENT is a transport census: every call it counts carries exactly
 * one {@link TransportPlane}, and the report line says `transport census`.
 *
 *  - `http` — the Fastify tRPC plugin, hooked at the context factory
 *    (`http-request-census-hook.ts`), which tRPC runs once per HTTP request.
 *  - `ws`   — `applyWSSHandler`, hooked at the client MESSAGE
 *    (`ws-request-census.ts`), because the WS adapter builds one context per
 *    CONNECTION and a per-connection hook fires once every 37 connections
 *    instead of once every call. This was the blind spot: `main.ts` states the
 *    viewer talks over `wsLink` EXCLUSIVELY, and names `deviceManager.listAll`
 *    while doing so.
 *  - `mesh` — the in-process `$core-caps` bridge (`core-cap-bridge.ts`), a
 *    `createCaller` that never touches a socket and so was invisible to any
 *    transport instrument by construction.
 *  - `unknown` — counted, plane undecidable. No hook produces it today, and its
 *    `0` is the claim that every plane the hub has can name itself. It exists
 *    so that a call is never lost and never silently absent;
 *    `planesExplainTotal` is the check.
 *
 * ## What this counts, and what the FLEET census counts - read them together
 *
 * These two instruments overlap and must not be added up:
 *
 *  - This one counts ENTRIES INTO THE HUB'S tRPC ROUTER, one row per
 *    operation, attributed to a plane and a caller.
 *  - `FleetReadCensus`
 *    (`packages/system/src/builtins/device-manager/fleet-read-census.ts`)
 *    counts READS OF THE DEVICE ROW STORE, wherever they came from,
 *    attributed to a JS call site - or, for a call that arrived over the cap
 *    channel, to `addon:<id>` carried as data.
 *
 * A single viewer `deviceManager.listAll` is ONE row here (plane `ws`) and ONE
 * row there (a stack site). Summing them double-counts it. The reconciliation
 * that is meaningful runs the other way:
 *
 *     fleet.totalCalls - Σ fleet.rows[site startsWith 'addon:'].calls
 *       ==  this.procedures['deviceManager.listAll'].calls
 *
 * i.e. store reads that did NOT arrive over the cap channel should be exactly
 * the router entries this census saw, over the SAME window. When it does not
 * balance, a plane is missing from this instrument - which is a result. The
 * two windows are armed separately (this one from the logging document, the
 * fleet one from `CAMSTACK_FLEET_READ_CENSUS_MS`), so the comparison is only
 * valid when both were armed across the same boot; nothing here joins them
 * automatically, because a join across two differently-armed windows would
 * produce a confident wrong number.
 *
 * ## The number this exists to explain
 *
 * `FleetReadCensus` (`packages/system/src/builtins/device-manager/fleet-read-census.ts`)
 * measured `deviceManager.listAll` at **4 960 calls in a two-minute boot
 * window**, ~1 017 rows each. It attributes the ADDONS correctly (~64 calls in
 * total, carried as data over the cap channel) and says **nothing** about the
 * other 4 900 - by construction: it lives in the row store and can only read
 * the local JS stack, and for a call that arrived over the wire every frame
 * above it is the same generic dispatcher regardless of who called.
 *
 * The HTTP layer is the one place that still holds the caller's identity:
 * source IP, `User-Agent`, and the principal the bearer resolved to. So this
 * census counts there.
 *
 * Two client-side fixes (admin-ui `GlobalSearch`, embed `EmbedGridPage`) moved
 * the number from 4 888 to 4 960 - i.e. not at all. Guessing the next most
 * plausible caller is exactly what this repo has already got wrong twice at
 * half a day each. An attribution is a measurement or it is a guess.
 *
 * ## Reading the NEGATIVE - an excluded plane is a result
 *
 * `snapshot().procedures[]` is the TOTAL per procedure over the window, split
 * by plane. Excluding a plane is worth as much as naming a caller, and it is
 * only worth anything if the exclusion is legible - so every plane is reported
 * even at `0`. An absent key reads as "not instrumented"; a `0` reads as
 * "instrumented, and it was not this one".
 *
 * A census that collected nothing still reports. Silence after an arm is
 * indistinguishable from a census that never armed.
 *
 * ## A subscription is not a query
 *
 * Subscription starts are counted APART from calls and never enter
 * `procedureCalls`. One `live.events` stream opened at boot and held for six
 * hours is one operation; folding it in would let a quiet plane wear the
 * costume of a storm - the exact misreading this whole instrument exists to
 * prevent.
 *
 * ## Cost when disarmed
 *
 * {@link HttpRequestCensus.armed} is a plain boolean FIELD, not a clock
 * comparison. Every caller checks it first and returns - no `Date.now()`, no
 * string, no allocation. This sits on the hub's tRPC entry path at ~41
 * requests/second; a diagnostic that costs something while switched off is a
 * tax nobody remembers enabling.
 *
 * The window therefore closes on a TIMER rather than on a clock read taken per
 * request. Stale timers are neutralised by a generation counter instead of
 * being cleared, so no timer handle has to be stored or typed.
 */

import type {
  IScopedLogger,
  RequestCensusGroup,
  RequestCensusProcedure,
  RequestCensusSnapshot,
  TransportPlane,
  TransportPlaneCounts,
} from '@camstack/types'

/** Route prefix the tRPC plugin is registered under (`main.ts`). */
export const TRPC_URL_PREFIX = '/trpc/'

/**
 * Longest window the census may be armed for.
 *
 * Thirty minutes rather than the ten `FleetReadCensus` allows, because the
 * measurement this instrument exists for spans a RESTART: the operator arms
 * it, restarts the hub, and the boot storm has to land inside the window that
 * was already running. Ten minutes is not enough room for a container
 * recreation plus a cold boot.
 */
export const MAX_WINDOW_MS = 30 * 60_000

/** Shortest useful window. Anything below this cannot contain a boot. */
export const MIN_WINDOW_MS = 1_000

/** Default cadence of the aggregated report line. */
export const DEFAULT_REPORT_EVERY_MS = 30_000

/**
 * Floor on the report cadence.
 *
 * The report is ONE aggregated line. At the measured rate a per-request line
 * would be 41 lines a second, which is itself an incident - and a cadence an
 * operator could set to 100 ms would reproduce that with an aggregate.
 */
export const MIN_REPORT_EVERY_MS = 5_000

/**
 * Bound on distinct `(procedure, ua, ip, principal)` groups held in memory.
 *
 * IPs and user-agents are attacker-influenced: a client rotating either would
 * otherwise grow the map without limit inside an armed window. Overflow is
 * COUNTED, never dropped silently - the totals stay exact, which is what the
 * negative proof rests on.
 */
export const MAX_GROUPS = 500

/**
 * Bound on distinct procedure names. The router's procedure set is closed and
 * far below this; the bound exists so a garbage path cannot grow the map.
 * Names beyond it fold into {@link PROCEDURE_OVERFLOW} rather than vanishing.
 */
export const MAX_PROCEDURES = 500

/** User-agent prefix kept in a group key. Full UA strings are long and their
 *  tail is build metadata that splits one client into many rows. */
export const USER_AGENT_MAX_CHARS = 80

/** Bound on procedures counted from one batched URL. tRPC's own `maxBatchSize`
 *  guards the router; this guards the census against a URL that never reaches
 *  a procedure at all. */
export const MAX_BATCH_PROCEDURES = 200

/** Synthetic name for batch entries beyond {@link MAX_BATCH_PROCEDURES}. */
export const BATCH_OVERFLOW_PROCEDURE = '(batch-overflow)'

/** Synthetic name for procedures beyond {@link MAX_PROCEDURES}. */
export const PROCEDURE_OVERFLOW = '(procedure-overflow)'

/** Placeholder used when a request carries no such signal. Never blank: an
 *  empty field reads as a logging defect rather than as an absent header. */
export const UNKNOWN = 'unknown'

/** Group-key field separator. A character that cannot appear in a tRPC
 *  procedure path, so two different tuples can never collide into one row. */
const KEY_SEPARATOR = ' | '

/**
 * The shapes this census reports in are the CAP's shapes
 * (`packages/types/src/capabilities/system.cap.ts`), derived from their Zod
 * schemas with `z.infer<>`. A second local interface describing the same rows
 * is how a wire contract and its producer drift apart while both compile.
 */

/** One observed HTTP request, already reduced to the fields that are counted. */
export interface RequestCensusObservation {
  readonly procedures: readonly string[]
  readonly userAgent: string | null
  readonly ip: string | null
  /** Derived principal, e.g. `apocaliss92 (admin)`. NEVER a token and never an
   *  `Authorization` header - see `describeTrpcPrincipal`. */
  readonly principal: string
}

/**
 * What KIND of operation was observed.
 *
 * `subscription` is separated from `call` at the type level rather than by a
 * boolean, so a new plane cannot forget which bucket its operations belong in:
 * the compiler asks.
 */
export type TransportOperationKind = 'call' | 'subscription'

/** One observed operation on a named plane. */
export interface TransportObservation extends RequestCensusObservation {
  readonly plane: TransportPlane
  readonly kind: TransportOperationKind
}

/**
 * A zeroed counter for every plane.
 *
 * Exhaustive by TYPE, not by discipline: adding a value to the wire enum makes
 * this literal fail to compile until it is given a counter. That is what keeps
 * "a plane is never silently absent" from being a comment nobody enforces.
 */
export function zeroPlaneCounts(): Record<TransportPlane, number> {
  return { http: 0, ws: 0, mesh: 0, unknown: 0 }
}

/** Frozen view of a mutable plane counter, for the wire. */
function freezePlaneCounts(counts: Readonly<Record<TransportPlane, number>>): TransportPlaneCounts {
  return { http: counts.http, ws: counts.ws, mesh: counts.mesh, unknown: counts.unknown }
}

function sumPlaneCounts(counts: Readonly<Record<TransportPlane, number>>): number {
  return counts.http + counts.ws + counts.mesh + counts.unknown
}

/** Injected clock. Production reads `Date.now`; specs drive it by hand. */
export type NowFn = () => number

/**
 * Injected one-shot scheduler.
 *
 * A plain `(fn, ms) => void` on purpose: nothing is ever cleared, so no timer
 * handle has to be stored, typed or cast. A timer that fires for a window that
 * has since been re-armed or disarmed is dropped by its generation stamp.
 */
export type ScheduleFn = (fn: () => void, ms: number) => void

export interface HttpRequestCensusOptions {
  readonly now?: NowFn
  readonly schedule?: ScheduleFn
}

interface MutableGroup {
  readonly plane: TransportPlane
  readonly procedure: string
  readonly userAgent: string
  readonly ip: string
  readonly principal: string
  calls: number
  subscriptions: number
}

interface MutableCount {
  calls: number
  subscriptions: number
  readonly planes: Record<TransportPlane, number>
}

function defaultSchedule(fn: () => void, ms: number): void {
  // `unref` so an armed census never holds the process open at shutdown.
  setTimeout(fn, ms).unref()
}

/**
 * Truncate a user-agent to a comparable prefix.
 *
 * Exported because the truncation is part of the group KEY: a spec that builds
 * an expected key by hand must use the same rule, or it pins the wrong thing.
 */
export function shortenUserAgent(ua: string | null): string {
  if (ua === null) return UNKNOWN
  const trimmed = ua.trim()
  if (trimmed.length === 0) return UNKNOWN
  if (trimmed.length <= USER_AGENT_MAX_CHARS) return trimmed
  return `${trimmed.slice(0, USER_AGENT_MAX_CHARS)}~`
}

/**
 * The procedures one tRPC HTTP request invokes.
 *
 * ## Why this is not `url.split(',')`
 *
 * tRPC splits the path on `,` **only when `batch=1`**, and only for the JSON
 * content-type handler; `multipart/form-data` and `application/octet-stream`
 * are always single-call, and a non-batched path containing a comma is ONE
 * procedure name. Counting a batch as one call undercounts by the batch factor
 * - in exactly the direction that would clear an innocent transport - and
 * splitting a non-batch path overcounts. Both rules are mirrored here
 * deliberately from `@trpc/server`'s `jsonContentTypeHandler.parse`, and both
 * are pinned by spec.
 *
 * Returns `[]` for a URL that is not under the tRPC prefix, and for the bare
 * prefix with no path.
 */
export function parseTrpcProcedures(url: string, contentType?: string | null): readonly string[] {
  const queryAt = url.indexOf('?')
  const pathname = queryAt === -1 ? url : url.slice(0, queryAt)
  const query = queryAt === -1 ? '' : url.slice(queryAt + 1)
  if (!pathname.startsWith(TRPC_URL_PREFIX)) return []

  // The plugin route is `/trpc/:path` - one segment. Anything after a further
  // `/` is not part of the procedure path.
  const rest = pathname.slice(TRPC_URL_PREFIX.length)
  const slashAt = rest.indexOf('/')
  const rawPath = slashAt === -1 ? rest : rest.slice(0, slashAt)
  if (rawPath.length === 0) return []

  const decoded = decodePathSafely(rawPath)
  if (!isBatchCall(query, contentType)) {
    const single = decoded.trim()
    return single.length === 0 ? [] : [single]
  }

  const out: string[] = []
  let overflowed = false
  for (const part of decoded.split(',')) {
    const name = part.trim()
    if (name.length === 0) continue
    if (out.length >= MAX_BATCH_PROCEDURES) {
      overflowed = true
      continue
    }
    out.push(name)
  }
  if (overflowed) out.push(BATCH_OVERFLOW_PROCEDURE)
  return out
}

/** `decodeURIComponent` throws on a malformed escape. A garbage path is still
 *  a request that arrived, so it is counted under its raw text rather than
 *  dropped - a dropped request is a hole in the total the negative rests on. */
function decodePathSafely(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * `batch=1` in the query string, and a content-type that can batch.
 *
 * The two non-JSON handlers hard-code `isBatchCall: false` regardless of the
 * query string, so honouring `batch=1` for them would split a procedure name
 * that legitimately contains a comma.
 */
function isBatchCall(query: string, contentType: string | null | undefined): boolean {
  if (!hasBatchFlag(query)) return false
  if (typeof contentType !== 'string') return true
  const lower = contentType.toLowerCase()
  if (lower.startsWith('multipart/form-data')) return false
  if (lower.startsWith('application/octet-stream')) return false
  return true
}

function hasBatchFlag(query: string): boolean {
  if (query.length === 0) return false
  for (const pair of query.split('&')) {
    if (pair === 'batch=1') return true
  }
  return false
}

/**
 * Armed-window counter for tRPC requests arriving over HTTP.
 *
 * Disarmed it is one boolean read at every call site and nothing else.
 */
export class HttpRequestCensus {
  private readonly now: NowFn
  private readonly schedule: ScheduleFn

  /** The ONLY thing a disarmed request path reads. */
  private isArmed = false

  /** Stamps every scheduled tick. A tick whose stamp is stale belongs to a
   *  window that was re-armed or disarmed, and does nothing. */
  private generation = 0

  private armedAt = 0
  private closedAt = 0
  private currentWindowMs = 0
  private currentReportEveryMs = DEFAULT_REPORT_EVERY_MS

  private httpRequests = 0
  private batchedRequests = 0
  private procedureCalls = 0
  private wsConnections = 0
  private wsMessages = 0
  private subscriptions = 0
  private subscriptionStops = 0
  private unattributedCalls = 0
  private planeCalls = zeroPlaneCounts()

  private readonly byProcedure = new Map<string, MutableCount>()
  private readonly byGroup = new Map<string, MutableGroup>()

  private logger: IScopedLogger | null = null

  constructor(options: HttpRequestCensusOptions = {}) {
    this.now = options.now ?? Date.now
    this.schedule = options.schedule ?? defaultSchedule
  }

  /** The report sink. Absent until boot wires it; a census with no logger
   *  still counts and still answers `snapshot()`. */
  setLogger(logger: IScopedLogger): void {
    this.logger = logger
  }

  get armed(): boolean {
    return this.isArmed
  }

  /** Epoch ms the current window closes at. 0 when disarmed. */
  get armedUntilMs(): number {
    return this.isArmed ? this.armedAt + this.currentWindowMs : 0
  }

  /**
   * Arm for `windowMs`, clamped to [{@link MIN_WINDOW_MS}, {@link MAX_WINDOW_MS}].
   *
   * Re-arming CLEARS the counts and restarts the window: two overlapping
   * measurements in one table is a table nobody can divide by a duration.
   */
  arm(windowMs: number, reportEveryMs: number = DEFAULT_REPORT_EVERY_MS): void {
    const clampedWindow = clamp(windowMs, MIN_WINDOW_MS, MAX_WINDOW_MS)
    const clampedReport = clamp(reportEveryMs, MIN_REPORT_EVERY_MS, clampedWindow)
    this.reset()
    this.generation += 1
    this.isArmed = true
    this.armedAt = this.now()
    this.closedAt = 0
    this.currentWindowMs = clampedWindow
    this.currentReportEveryMs = clampedReport
    this.scheduleTick(this.generation)
  }

  /**
   * Close the window now and emit the final report.
   *
   * The counts SURVIVE - a window may be read as many times as the operator
   * likes after it closed, and re-arming in order to read would throw away
   * exactly the numbers being asked for.
   */
  disarm(reason: string): void {
    if (!this.isArmed) return
    this.isArmed = false
    this.closedAt = this.now()
    this.generation += 1
    this.report(reason)
  }

  /**
   * Count one HTTP request.
   *
   * Callers check {@link armed} FIRST so nothing is built for a disarmed
   * census; the guard is repeated here so a request already in flight when the
   * window closed cannot land in a window it does not belong to.
   */
  observeHttpRequest(observation: RequestCensusObservation): void {
    if (!this.isArmed) return
    if (observation.procedures.length === 0) return

    this.httpRequests += 1
    if (observation.procedures.length > 1) this.batchedRequests += 1

    this.observe({ ...observation, plane: 'http', kind: 'call' })
  }

  /**
   * Count operations on ANY plane.
   *
   * The plane is data rather than a method name so that a plane added later
   * cannot quietly reuse the HTTP bookkeeping (`httpRequests`,
   * `batchedRequests`), which counts REQUESTS and means nothing off HTTP.
   */
  observe(observation: TransportObservation): void {
    if (!this.isArmed) return
    if (observation.procedures.length === 0) return

    const userAgent = shortenUserAgent(observation.userAgent)
    const ip = observation.ip ?? UNKNOWN
    const { plane, kind, principal } = observation

    for (const procedure of observation.procedures) {
      if (kind === 'subscription') this.subscriptions += 1
      else {
        this.procedureCalls += 1
        this.planeCalls[plane] += 1
      }
      this.countProcedure(procedure, plane, kind)

      const key = [plane, procedure, userAgent, ip, principal].join(KEY_SEPARATOR)
      const group = this.byGroup.get(key)
      if (group !== undefined) {
        if (kind === 'subscription') group.subscriptions += 1
        else group.calls += 1
        continue
      }
      if (this.byGroup.size >= MAX_GROUPS) {
        this.unattributedCalls += 1
        continue
      }
      this.byGroup.set(key, {
        plane,
        procedure,
        userAgent,
        ip,
        principal,
        calls: kind === 'subscription' ? 0 : 1,
        subscriptions: kind === 'subscription' ? 1 : 0,
      })
    }
  }

  /**
   * Count one tRPC WebSocket connection opening.
   *
   * NOT a call count - the WS adapter resolves one context per connection.
   * Kept alongside the per-operation `ws` plane because "37 connections, 0
   * calls" and "0 connections, 0 calls" are different answers.
   */
  observeWsConnection(): void {
    if (!this.isArmed) return
    this.wsConnections += 1
  }

  /** Count one client frame the WS plane inspected, operation or not. */
  observeWsMessage(): void {
    if (!this.isArmed) return
    this.wsMessages += 1
  }

  /**
   * Count `subscription.stop` frames.
   *
   * Stops carry no procedure path on the wire (tRPC's stop message is `{ id }`
   * and nothing else), so they are a scalar rather than a group row - inventing
   * a path for them would put a name on the line that the client never sent.
   */
  observeSubscriptionStop(count: number = 1): void {
    if (!this.isArmed) return
    this.subscriptionStops += count
  }

  /** Everything the window measured, busiest first. */
  snapshot(limit: number = MAX_GROUPS): RequestCensusSnapshot {
    const elapsedMs = this.elapsedMs()
    const perMin = (calls: number): number =>
      elapsedMs === 0 ? 0 : Math.round((calls * 60_000) / elapsedMs)
    const procedures = [...this.byProcedure.entries()]
      .map(
        ([procedure, count]): RequestCensusProcedure => ({
          procedure,
          calls: count.calls,
          planes: freezePlaneCounts(count.planes),
          subscriptions: count.subscriptions,
          perMin: perMin(count.calls),
        }),
      )
      .toSorted((a, b) => b.calls - a.calls)
    const groups = [...this.byGroup.values()]
      .map(
        (group): RequestCensusGroup => ({
          plane: group.plane,
          procedure: group.procedure,
          userAgent: group.userAgent,
          ip: group.ip,
          principal: group.principal,
          calls: group.calls,
          subscriptions: group.subscriptions,
          perMin: perMin(group.calls),
        }),
      )
      .toSorted((a, b) => b.calls + b.subscriptions - (a.calls + a.subscriptions))
    return {
      armed: this.isArmed,
      elapsedMs,
      windowMs: this.currentWindowMs,
      armedUntilMs: this.armedUntilMs,
      httpRequests: this.httpRequests,
      batchedRequests: this.batchedRequests,
      procedureCalls: this.procedureCalls,
      planes: freezePlaneCounts(this.planeCalls),
      planesExplainTotal: sumPlaneCounts(this.planeCalls) === this.procedureCalls,
      wsConnections: this.wsConnections,
      wsMessages: this.wsMessages,
      subscriptions: this.subscriptions,
      subscriptionStops: this.subscriptionStops,
      distinctGroups: this.byGroup.size,
      unattributedCalls: this.unattributedCalls,
      procedures: procedures.slice(0, limit),
      groups: groups.slice(0, limit),
    }
  }

  /**
   * Emit ONE aggregated line - the line that answers the question.
   *
   * Field order is the reading order: `planes` first (which transport), then
   * `planesExplainTotal` (is any call unaccounted for), then `procedures`
   * (which procedure, split by plane), then `top` (which caller). `top` is the
   * part that may be cut; the first three never are.
   *
   * The message is `transport census` rather than `http request census`
   * because the line now carries three planes. Grepping Loki for the old text
   * would find only pre-2026-08-27 windows, which is the honest outcome: those
   * windows really did measure one plane.
   */
  report(phase: string): void {
    const logger = this.logger
    if (logger === null) return
    const snap = this.snapshot()
    logger.info('transport census', {
      meta: {
        phase,
        armed: snap.armed,
        elapsedMs: snap.elapsedMs,
        windowMs: snap.windowMs,
        planes: snap.planes,
        procedureCalls: snap.procedureCalls,
        // The acceptance criterion, ON the line: false means a call was
        // counted on no plane, i.e. this instrument is missing one.
        planesExplainTotal: snap.planesExplainTotal,
        subscriptions: snap.subscriptions,
        subscriptionStops: snap.subscriptionStops,
        httpRequests: snap.httpRequests,
        batchedRequests: snap.batchedRequests,
        wsConnections: snap.wsConnections,
        wsMessages: snap.wsMessages,
        distinctGroups: snap.distinctGroups,
        unattributedCalls: snap.unattributedCalls,
        procedures: snap.procedures.slice(0, REPORTED_PROCEDURES),
        top: snap.groups.slice(0, REPORTED_GROUPS).map((group) => ({
          plane: group.plane,
          procedure: group.procedure,
          ua: group.userAgent,
          ip: group.ip,
          principal: group.principal,
          calls: group.calls,
          subscriptions: group.subscriptions,
          perMin: group.perMin,
        })),
      },
    })
  }

  private countProcedure(
    procedure: string,
    plane: TransportPlane,
    kind: TransportOperationKind,
  ): void {
    const existing = this.byProcedure.get(procedure)
    if (existing !== undefined) {
      bumpCount(existing, plane, kind)
      return
    }
    if (this.byProcedure.size >= MAX_PROCEDURES) {
      const overflow = this.byProcedure.get(PROCEDURE_OVERFLOW) ?? newCount()
      bumpCount(overflow, plane, kind)
      this.byProcedure.set(PROCEDURE_OVERFLOW, overflow)
      return
    }
    const fresh = newCount()
    bumpCount(fresh, plane, kind)
    this.byProcedure.set(procedure, fresh)
  }

  private elapsedMs(): number {
    if (this.armedAt === 0) return 0
    const end = this.isArmed ? this.now() : this.closedAt
    return Math.max(0, end - this.armedAt)
  }

  private reset(): void {
    this.byProcedure.clear()
    this.byGroup.clear()
    this.httpRequests = 0
    this.batchedRequests = 0
    this.procedureCalls = 0
    this.wsConnections = 0
    this.wsMessages = 0
    this.subscriptions = 0
    this.subscriptionStops = 0
    this.unattributedCalls = 0
    this.planeCalls = zeroPlaneCounts()
  }

  private scheduleTick(generation: number): void {
    this.schedule(() => {
      if (generation !== this.generation || !this.isArmed) return
      if (this.now() - this.armedAt >= this.currentWindowMs) {
        this.disarm('window-closed')
        return
      }
      this.report('interval')
      this.scheduleTick(generation)
    }, this.currentReportEveryMs)
  }
}

/** Per-procedure rows carried on one report line. The router's procedure set
 *  is small; this is a guard against a garbage path, not a real cut. */
const REPORTED_PROCEDURES = 40

/** Caller groups carried on one report line. Enough to name a culprit,
 *  bounded so one line stays a line. */
const REPORTED_GROUPS = 25

function newCount(): MutableCount {
  return { calls: 0, subscriptions: 0, planes: zeroPlaneCounts() }
}

function bumpCount(count: MutableCount, plane: TransportPlane, kind: TransportOperationKind): void {
  if (kind === 'subscription') {
    count.subscriptions += 1
    return
  }
  count.calls += 1
  count.planes[plane] += 1
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), max)
}
