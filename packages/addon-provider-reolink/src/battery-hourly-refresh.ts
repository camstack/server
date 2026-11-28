/**
 * The battery camera's scheduled full refresh (D847).
 *
 * ## The failure this closes
 *
 * 2026-10-13, device 106 ("Baby monitor", standalone battery): Dominevo showed
 * 80 % until the camera died, then 11 %. Every fresh reading of a sleeping
 * battery camera arrived only as a side effect — a firmware `battery` push, a
 * wake some consumer caused — and the hourly timer that existed was written to
 * do nothing at all while the camera slept (it "never wakes"). A quiet night
 * therefore froze every fact for as long as the camera slept, with no staleness
 * visible anywhere. The camera is the owner of its facts (D224); a window on how
 * old they may be belongs to the owner too.
 *
 * ## The rule (the operator's own words)
 *
 * Every window (default 60 min) a battery camera refreshes ALL its metadata and
 * its cached snapshot EXACTLY ONCE — either by being woken for it, or, if it is
 * found awake during that window anyway (an event, a live view, someone else's
 * wake), by refreshing at that moment and skipping the wake.
 *
 * ## How "exactly once per window" is made true
 *
 * - Windows are consecutive slices of the clock, staggered per device so a fleet
 *   does not wake in the same minute: window `k` is
 *   `[offset + k·I, offset + (k+1)·I)`. The stamp
 *   (`battery.lastFullRefreshAt`) is persisted, so a restart neither forgets a
 *   refresh nor repeats one.
 * - A refresh is NEEDED iff the stamp lies in an earlier window than now.
 * - Awake and needed ⇒ refresh now. Asleep and needed ⇒ do nothing UNTIL the
 *   window's wake deadline (its last {@link wakeLeadMs}), and only then wake.
 *   The deadline is what gives an awake moment the whole window to arrive
 *   first and spare the camera the wake.
 * - One refresh at a time: a second request while one runs joins it.
 * - A failed attempt does not stamp — except one whose only failure is a stale
 *   snapshot, which is stamped (the camera answered; see `run`).
 *   Any other failure is retried at the next opportunity, at
 *   most {@link MAX_ATTEMPTS_PER_WINDOW} attempts per window and never closer
 *   than {@link RETRY_BACKOFF_MS} — a camera that will not answer costs the
 *   battery two wakes a window at worst, never a loop.
 *
 * The decision is pure ({@link decideBatteryRefresh}); the controller owns the
 * attempt bookkeeping and the single-flight, and is driven by fakes in the spec.
 */
import type { IScopedLogger } from '@dominevo/types'

/** The default window, in minutes. */
export const BATTERY_REFRESH_MINUTES_DEFAULT = 60
/** 0 turns the scheduled refresh off for a camera. */
export const BATTERY_REFRESH_OFF = 0
/** The smallest non-zero window an operator may set. */
export const BATTERY_REFRESH_MINUTES_MIN = 15
/**
 * The longest window: below the 6 h presence budget
 * (`BATTERY_UNREACHABLE_AFTER_MS`), so the refresh itself keeps a standalone
 * camera from reading `unreachable` (this supersedes D355's separate wake).
 */
export const BATTERY_REFRESH_MINUTES_MAX = 240
/** The settings key, per device. */
export const BATTERY_REFRESH_MINUTES_KEY = 'batteryRefreshMinutes'

/** How often the in-memory check runs. Costs nothing: no I/O unless it fires. */
export const BATTERY_REFRESH_TICK_MS = 60_000
/** Attempts (wakes included) one window may spend. */
export const MAX_ATTEMPTS_PER_WINDOW = 2
/** The least time between two attempts in one window. */
export const RETRY_BACKOFF_MS = 10 * 60_000
/**
 * How old the last full refresh may grow while a stream is open before the
 * control burst runs under that stream anyway. A camera that streams 24/7
 * would otherwise never refresh battery, accessories or settings.
 */
export const STREAM_DEFER_MAX_AGE_MS = 4 * 60 * 60_000
/** The one refresh step whose failure does not hold the window open. */
const SOFT_FAILURE_STEP = 'snapshot'
const MAX_WAKE_LEAD_MS = 5 * 60_000
const STAGGER_SLOTS = 60

/** The operator's window in ms, or `0` for off. Out-of-range values clamp. */
export function resolveBatteryRefreshIntervalMs(configured: unknown): number {
  if (typeof configured !== 'number' || !Number.isFinite(configured)) {
    return BATTERY_REFRESH_MINUTES_DEFAULT * 60_000
  }
  if (configured <= BATTERY_REFRESH_OFF) return 0
  const minutes = Math.min(
    BATTERY_REFRESH_MINUTES_MAX,
    Math.max(BATTERY_REFRESH_MINUTES_MIN, Math.round(configured)),
  )
  return minutes * 60_000
}

/** Deterministic per-device offset so a fleet's windows do not align. */
export function staggerOffsetMs(deviceId: number, intervalMs: number): number {
  const slot = Math.abs(Math.trunc(deviceId)) % STAGGER_SLOTS
  return Math.floor((intervalMs / STAGGER_SLOTS) * slot)
}

/** Which window a wall-clock instant falls in. */
export function windowIndex(at: number, intervalMs: number, offsetMs: number): number {
  return Math.floor((at - offsetMs) / intervalMs)
}

/** How long before a window's end the wake is allowed to fire. */
export function wakeLeadMs(intervalMs: number): number {
  return Math.min(MAX_WAKE_LEAD_MS, Math.floor(intervalMs / 10))
}

export interface BatteryRefreshDecisionInput {
  readonly nowMs: number
  readonly intervalMs: number
  readonly offsetMs: number
  /** The persisted stamp; `undefined` = never refreshed. */
  readonly lastFullRefreshAt: number | undefined
  /** The mirror's `!sleeping` — an observation, never a probe. */
  readonly awake: boolean
  /** Attempts already spent in THIS window. */
  readonly attemptsInWindow: number
  readonly lastAttemptAt: number | undefined
}

export type BatteryRefreshDecision =
  | { readonly kind: 'refresh-awake' }
  | { readonly kind: 'wake-then-refresh' }
  | {
      readonly kind: 'skip'
      readonly reason: 'off' | 'done' | 'asleep-before-deadline' | 'backoff' | 'attempts-exhausted'
    }

export function decideBatteryRefresh(input: BatteryRefreshDecisionInput): BatteryRefreshDecision {
  if (input.intervalMs <= 0) return { kind: 'skip', reason: 'off' }
  const current = windowIndex(input.nowMs, input.intervalMs, input.offsetMs)
  const last =
    typeof input.lastFullRefreshAt === 'number' && input.lastFullRefreshAt > 0
      ? windowIndex(input.lastFullRefreshAt, input.intervalMs, input.offsetMs)
      : Number.NEGATIVE_INFINITY
  if (last >= current) return { kind: 'skip', reason: 'done' }
  if (input.attemptsInWindow >= MAX_ATTEMPTS_PER_WINDOW) {
    return { kind: 'skip', reason: 'attempts-exhausted' }
  }
  if (
    input.lastAttemptAt !== undefined &&
    input.attemptsInWindow > 0 &&
    input.nowMs - input.lastAttemptAt < RETRY_BACKOFF_MS
  ) {
    return { kind: 'skip', reason: 'backoff' }
  }
  if (input.awake) return { kind: 'refresh-awake' }
  const windowEnd = input.offsetMs + (current + 1) * input.intervalMs
  if (input.nowMs < windowEnd - wakeLeadMs(input.intervalMs)) {
    return { kind: 'skip', reason: 'asleep-before-deadline' }
  }
  return { kind: 'wake-then-refresh' }
}

/** What one full refresh reports: `failed` names every step that did not land. */
export interface BatteryRefreshOutcome {
  readonly failed: readonly string[]
}

export interface BatteryRefreshDeps {
  readonly deviceId: number
  readonly logger: IScopedLogger
  readonly now: () => number
  /** The mirror's view: not sleeping. */
  readonly isAwake: () => boolean
  /**
   * A broker stream of the camera is open — in-memory, never a read. While it
   * is, the control burst of a refresh is deferred (the firmware pauses video
   * while the control session is busy). Optional: absent = never streaming.
   */
  readonly isStreaming?: () => boolean
  /** The configured window in ms (`0` = off), read at each check. */
  readonly intervalMs: () => number
  readonly lastFullRefreshAt: () => number | undefined
  /** The provider's existing wake path; resolves whether the camera is up. */
  readonly wake: () => Promise<boolean>
  /** Reads every fact and the snapshot. Never stamps; the controller does. */
  readonly refreshAll: () => Promise<BatteryRefreshOutcome>
  readonly stamp: (at: number) => void
  /** Persisted attempt bookkeeping: a restart neither forgets an attempt nor repeats it. */
  readonly attemptLedger?: RefreshAttemptLedger
}

export type RefreshTrigger = 'tick' | 'wake-transition'

/** The attempt bookkeeping of ONE window — what a restart must not forget. */
export interface RefreshAttemptRecord {
  readonly window: number
  readonly attempts: number
  readonly lastAttemptAt: number | undefined
}

/**
 * Where the attempt record lives between restarts. The camera backs it with
 * the persisted battery slice, next to `lastFullRefreshAt`. Absent = in memory
 * only (specs).
 */
export interface RefreshAttemptLedger {
  readonly read: () => RefreshAttemptRecord | undefined
  readonly write: (record: RefreshAttemptRecord) => void
}

/** The persisted bookkeeping of the scheduled refresh, as the battery slice carries it. */
export type RefreshBookkeeping = {
  readonly lastFullRefreshAt?: number | undefined
  readonly refreshAttemptWindow?: number | undefined
  readonly refreshAttempts?: number | undefined
  readonly refreshLastAttemptAt?: number | undefined
}

/**
 * A FULL-slice write replaces the slice, so every writer that composes its own
 * value must carry the scheduled refresh's bookkeeping over from the slice it
 * replaces. Dropping it makes a restart read "never refreshed" and owe the
 * camera a wake (#666: the stamp read back `null` after any battery read that
 * followed it).
 */
export function carryRefreshBookkeeping<T extends object>(
  previous: RefreshBookkeeping,
  next: T,
): T & RefreshBookkeeping {
  return {
    ...next,
    ...(previous.lastFullRefreshAt !== undefined
      ? { lastFullRefreshAt: previous.lastFullRefreshAt }
      : {}),
    ...(previous.refreshAttemptWindow !== undefined
      ? { refreshAttemptWindow: previous.refreshAttemptWindow }
      : {}),
    ...(previous.refreshAttempts !== undefined
      ? { refreshAttempts: previous.refreshAttempts }
      : {}),
    ...(previous.refreshLastAttemptAt !== undefined
      ? { refreshLastAttemptAt: previous.refreshLastAttemptAt }
      : {}),
  }
}

/** The ledger over the slice's flat fields; `write` receives the patch to persist. */
export function attemptLedgerOverSlice(
  readSlice: () => RefreshBookkeeping,
  writeFields: (fields: Required<Omit<RefreshBookkeeping, 'lastFullRefreshAt'>>) => void,
): RefreshAttemptLedger {
  return {
    read: () => {
      const s = readSlice()
      if (typeof s.refreshAttemptWindow !== 'number' || typeof s.refreshAttempts !== 'number') {
        return undefined
      }
      return {
        window: s.refreshAttemptWindow,
        attempts: s.refreshAttempts,
        lastAttemptAt: s.refreshLastAttemptAt,
      }
    },
    write: (r) =>
      writeFields({
        refreshAttemptWindow: r.window,
        refreshAttempts: r.attempts,
        refreshLastAttemptAt: r.lastAttemptAt ?? 0,
      }),
  }
}

export class BatteryHourlyRefresh {
  private inFlight: Promise<boolean> | null = null
  private attemptWindow = Number.NEGATIVE_INFINITY
  private attempts = 0
  private lastAttemptAt: number | undefined
  private hydrated = false

  constructor(private readonly deps: BatteryRefreshDeps) {}

  /**
   * The periodic check. Resolves `true` when a refresh landed in this call.
   * Never throws.
   */
  async tick(): Promise<boolean> {
    return this.consider('tick')
  }

  /**
   * The camera was just observed coming up (event, sleep poll, hub summary, a
   * confirmed wake). Resolves `true` when this call refreshed everything, so
   * the caller can skip the parts of its own fan-out the refresh already did.
   */
  async noteAwake(): Promise<boolean> {
    return this.consider('wake-transition')
  }

  private async consider(trigger: RefreshTrigger): Promise<boolean> {
    if (this.inFlight !== null) return this.inFlight
    const nowMs = this.deps.now()
    const intervalMs = this.deps.intervalMs()
    const offsetMs = intervalMs > 0 ? staggerOffsetMs(this.deps.deviceId, intervalMs) : 0
    const window = intervalMs > 0 ? windowIndex(nowMs, intervalMs, offsetMs) : 0
    this.hydrateAttempts()
    if (window !== this.attemptWindow) {
      this.attemptWindow = window
      this.attempts = 0
      this.lastAttemptAt = undefined
    }
    const decision = decideBatteryRefresh({
      nowMs,
      intervalMs,
      offsetMs,
      lastFullRefreshAt: this.deps.lastFullRefreshAt(),
      // A wake transition IS the observation, whatever the mirror says yet.
      awake: trigger === 'wake-transition' || this.deps.isAwake(),
      attemptsInWindow: this.attempts,
      lastAttemptAt: this.lastAttemptAt,
    })
    if (decision.kind === 'skip') {
      this.logSkip(decision.reason, trigger)
      return false
    }
    // Due, but a stream is open: defer WITHOUT spending an attempt or stamping —
    // the window stays owed and the next tick without a stream takes it.
    if (this.shouldDeferForStream()) {
      this.noteStreamDeferred(trigger)
      return false
    }
    if (this.deps.isStreaming?.() === true) this.logDeferralBoundReached(trigger)
    this.attempts += 1
    this.lastAttemptAt = nowMs
    this.deps.attemptLedger?.write({
      window,
      attempts: this.attempts,
      lastAttemptAt: nowMs,
    })
    const run = this.run(decision.kind, trigger).finally(() => {
      this.inFlight = null
    })
    this.inFlight = run
    return run
  }

  /** Once, at the first decision: take the persisted bookkeeping of the window a restart interrupted. */
  private hydrateAttempts(): void {
    if (this.hydrated) return
    this.hydrated = true
    const stored = this.deps.attemptLedger?.read()
    if (stored === undefined) return
    this.attemptWindow = stored.window
    this.attempts = stored.attempts
    this.lastAttemptAt =
      typeof stored.lastAttemptAt === 'number' && stored.lastAttemptAt > 0
        ? stored.lastAttemptAt
        : undefined
  }

  /**
   * A stream is open AND the last full refresh is younger than
   * {@link STREAM_DEFER_MAX_AGE_MS}: the control burst waits. Past that age (or
   * with no refresh on record) it runs under the stream — the deferral is bounded.
   */
  shouldDeferForStream(): boolean {
    if (this.deps.isStreaming?.() !== true) return false
    const last = this.deps.lastFullRefreshAt()
    if (typeof last !== 'number' || last <= 0) return false
    return this.deps.now() - last < STREAM_DEFER_MAX_AGE_MS
  }

  logDeferralBoundReached(what: string): void {
    this.deps.logger.info(
      'battery control burst: deferral bound reached — refreshing under an active stream',
      {
        tags: { deviceId: this.deps.deviceId },
        meta: { what, maxAgeMs: STREAM_DEFER_MAX_AGE_MS },
      },
    )
  }

  private streamDeferLoggedWindow = Number.NEGATIVE_INFINITY

  /** Say once per window that a due control burst was held back for a stream. */
  noteStreamDeferred(what: string): void {
    const intervalMs = this.deps.intervalMs()
    const offsetMs = intervalMs > 0 ? staggerOffsetMs(this.deps.deviceId, intervalMs) : 0
    const window = intervalMs > 0 ? windowIndex(this.deps.now(), intervalMs, offsetMs) : 0
    if (window === this.streamDeferLoggedWindow) return
    this.streamDeferLoggedWindow = window
    this.deps.logger.info('battery control burst deferred — a stream is active', {
      tags: { deviceId: this.deps.deviceId },
      meta: { what },
    })
  }

  private async run(
    kind: 'refresh-awake' | 'wake-then-refresh',
    trigger: string,
  ): Promise<boolean> {
    const { logger, deviceId } = this.deps
    try {
      if (kind === 'wake-then-refresh') {
        logger.info('battery hourly refresh: not awake in the window — waking once', {
          tags: { deviceId },
          meta: { attempt: this.attempts },
        })
        const up = await this.deps.wake()
        if (!up) {
          logger.warn('battery hourly refresh: the wake did not bring the camera up', {
            tags: { deviceId },
            meta: { attempt: this.attempts, retryAfterMs: RETRY_BACKOFF_MS },
          })
          return false
        }
        // The wake's own transition may already have run the refresh and
        // stamped it; honour that instead of reading everything twice.
        if (this.windowSatisfied()) return true
      } else {
        logger.info('battery hourly refresh: camera is awake — refreshing now, no wake', {
          tags: { deviceId },
          meta: { trigger, attempt: this.attempts },
        })
      }
      const outcome = await this.deps.refreshAll()
      // A stale snapshot is not a failed refresh: the camera answered, it just
      // had no newer picture, and asking again only repeats a full refresh (a
      // wake, when asleep) for the same answer. It is the one failure that does
      // not hold the window open — said once, under the device tag.
      const hardFailures = outcome.failed.filter((step) => step !== SOFT_FAILURE_STEP)
      if (hardFailures.length === 0 && outcome.failed.length > 0) {
        logger.warn('battery hourly refresh: snapshot did not move — window stamped, not retried', {
          tags: { deviceId },
          meta: { failed: outcome.failed, attempt: this.attempts },
        })
      }
      if (hardFailures.length > 0) {
        logger.warn('battery hourly refresh incomplete — not stamped, retried at the next chance', {
          tags: { deviceId },
          meta: { failed: outcome.failed, attempt: this.attempts, retryAfterMs: RETRY_BACKOFF_MS },
        })
        return false
      }
      const at = this.deps.now()
      this.deps.stamp(at)
      logger.info('battery hourly refresh complete', {
        tags: { deviceId },
        meta: { kind, trigger, at },
      })
      return true
    } catch (err) {
      logger.warn('battery hourly refresh failed — retried at the next chance', {
        tags: { deviceId },
        meta: {
          error: err instanceof Error ? err.message : String(err),
          attempt: this.attempts,
          retryAfterMs: RETRY_BACKOFF_MS,
        },
      })
      return false
    }
  }

  private windowSatisfied(): boolean {
    const intervalMs = this.deps.intervalMs()
    if (intervalMs <= 0) return false
    const offsetMs = staggerOffsetMs(this.deps.deviceId, intervalMs)
    const last = this.deps.lastFullRefreshAt()
    if (typeof last !== 'number' || last <= 0) return false
    return (
      windowIndex(last, intervalMs, offsetMs) >= windowIndex(this.deps.now(), intervalMs, offsetMs)
    )
  }

  private logSkip(reason: string, trigger: RefreshTrigger): void {
    // `done` / `off` / `asleep-before-deadline` are the steady state of every
    // tick: logging them would be 1 440 lines a day a camera. The two that
    // DROP wanted work — a backoff and an exhausted window — are said.
    if (reason === 'backoff' || reason === 'attempts-exhausted') {
      this.deps.logger.info('battery hourly refresh skipped', {
        tags: { deviceId: this.deps.deviceId },
        meta: { reason, trigger, attempts: this.attempts },
      })
      return
    }
    this.deps.logger.debug('battery hourly refresh not due', {
      tags: { deviceId: this.deps.deviceId },
      meta: { reason, trigger },
    })
  }
}
