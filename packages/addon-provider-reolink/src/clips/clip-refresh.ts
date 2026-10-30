/**
 * The clip-catalog refresh — a timer whose COST is a per-topology question.
 *
 * ## Why this is not one rule
 *
 * A clip catalog goes stale because the camera keeps recording. Re-reading it
 * is cheap on some Reolink shapes and is the single most expensive thing the
 * system can do on others, and the difference is an order of magnitude — so
 * one timer with one meaning would be either useless or destructive. The
 * fleet, enumerated live on 2026-09-20 rather than assumed:
 *
 * | shape | devices | what a timer may do | measured |
 * | --- | --- | --- | --- |
 * | mains standalone | 592, 618 | read directly, its own socket | 0.3–6 s a day |
 * | hub child (battery, served by the parent) | 3628, 3629, 3825 | read THROUGH THE HUB with the child's uid | 65 ms, child never hears it |
 * | standalone battery | 640, 4263 | **nothing but mark the catalog stale** | a read IS a login IS a wake |
 * | the Home Hub itself | 639 | — | `type: hub`, never a `videoclips` device |
 *
 * **639 is mains, and it still gets no catalog of its own.** `videoclips`
 * declares `deviceTypes: [Camera]`, and the hub's own uid was measured to
 * address no catalog at all (an empty month over 24 months, zero files, zero
 * rows). A hub's catalog IS its children's; refreshing it means refreshing
 * each child, which is what `via-hub` does — on the hub's ONE session, which
 * is also why those refreshes must not run on top of each other.
 * Accessories (sirens, floodlights, PIR switches) are not cameras and never
 * bind the capability, so they never appear here.
 *
 * **A standalone battery camera cannot be refreshed by a clock.** The timer
 * marks its catalog stale and stops; the real refresh hangs off
 * `onWakeTransition` in `reolink-camera.ts`, which already fires on a camera
 * event, a stream or an operator action — the moments the camera confirmed
 * itself awake for its OWN reasons, and the moments that warm every other
 * settings slice today. There is no second wake hook, deliberately.
 *
 * ## Interactive work always wins
 *
 * The refresh shares the library's single CoverPreview lane, its host-keyed
 * backoff, and — on a hub — one socket for every child. A timer that starves
 * an operator staring at a tile is worse than no timer, so a busy host DEFERS
 * the refresh (and a deferral is not a run: it retries on the next tick).
 *
 * ## It also drags the still prefetch behind it (D577)
 *
 * D549-16's thumbnail prefetch was written and never called. This is its home,
 * because this is the only thing that knows — per camera, per tick — which
 * topology it is, that the catalog really landed, and whether an operator
 * holds the host's lane. It runs AFTER the listing (the stills are for the
 * rows that listing just confirmed), never after a `mark-stale` or a failure,
 * and never on a standalone battery camera in either mode. `hostBusy` is
 * therefore asked TWICE per camera per tick: a refresh is not instantaneous,
 * and the operator who took the lane during it must not queue behind a
 * prefetch. The rule and the costs are in `clip-prefetch.ts`.
 *
 * ## A failure never looks like a success
 *
 * `catalogAsOf` is stamped by the cache only on a listing that really landed,
 * so a failed refresh leaves it at the last CONFIRMED time. This module adds
 * the other half: it marks the rows stale so the next read retries, and it
 * SAYS which branch dropped the work, per camera.
 */
import type { IScopedLogger } from '@camstack/types'
import {
  type ClipPrefetchMode,
  type ClipPrefetchOutcome,
  decideClipPrefetch,
  prefetchQuietMs,
} from './clip-prefetch.js'

/** The settings key, global default and per-device override (D562). */
export const CLIP_CATALOG_REFRESH_MINUTES_KEY = 'clipCatalogRefreshMinutes'
/** The settings key, per device only, OFF by default (D562). */
export const CLIP_CATALOG_FORCED_WAKE_KEY = 'clipCatalogForcedWake'

/**
 * Half an hour. Cheap on the two shapes where the timer actually reads
 * (65 ms on a hub child, a few seconds on a mains standalone) and, on a
 * standalone battery camera, the rate at which its catalog is MARKED stale —
 * which costs nothing at all.
 */
export const CLIP_CATALOG_REFRESH_MINUTES_DEFAULT = 30
/** Below this the timer would re-ask faster than a camera can record. */
export const CLIP_CATALOG_REFRESH_MINUTES_MIN = 5
/** A day. Past this the catalog's own TTLs are the thing doing the work. */
export const CLIP_CATALOG_REFRESH_MINUTES_MAX = 1440
/** A real, settable value at both levels: no timer at all for this camera. */
export const CLIP_CATALOG_REFRESH_OFF = 0

/**
 * How much of the catalog one refresh confirms.
 *
 * A day. The listing cost is per DAY (0.3–6 s on a standalone, 267 ms for one
 * child-day on the hub) and a 20-day window measured 3.6–5.4 s per child, so a
 * timer that re-confirmed everything would spend the whole budget re-reading
 * days that cannot change. Older days are immutable and the cache holds them
 * under their own 24 h TTL.
 */
export const CLIP_CATALOG_REFRESH_WINDOW_MS = 24 * 60 * 60_000

/**
 * What a timer may do for one camera.
 *
 * `direct` — a mains standalone, on its own socket.
 * `via-hub` — a hub child, on the parent's open session with the child's uid.
 * `mark-stale` — a standalone battery camera: age the catalog, read nothing.
 * `forced-wake` — the same camera, when the operator explicitly authorised the
 *   battery cost. Never the default, and never reachable any other way.
 */
export type ClipRefreshMode = 'direct' | 'via-hub' | 'mark-stale' | 'forced-wake'

/** What the mode is decided from — the camera's SHAPE, plus one operator switch. */
export interface ClipRefreshTopology {
  readonly isHubChild: boolean
  readonly isBattery: boolean
  readonly forcedWake: boolean
}

/**
 * The mode for one camera. Pure, and decided from what the camera IS — never
 * from a belief about whether it is asleep right now: the gate has to hold for
 * a camera whose sleep slice has not restored, which reads "awake" and is how
 * a picker draw once logged into 640 (D561).
 */
export function resolveClipRefreshMode(topology: ClipRefreshTopology): ClipRefreshMode {
  // A hub child first, and regardless of its battery: the read goes to the
  // PARENT, which is mains and already has the socket open.
  if (topology.isHubChild) return 'via-hub'
  if (!topology.isBattery) return 'direct'
  return topology.forcedWake ? 'forced-wake' : 'mark-stale'
}

/**
 * The refresh interval for one camera: the per-device override on top of the
 * global default, with **reset == unset == the default**.
 *
 * Never throws on a bad blob. An invalid value at either level resolves to the
 * level above it, so a store written by an older release cannot stop the timer
 * — the same cascade `stationary-settings.ts` uses, for the same reason.
 */
export function resolveClipCatalogRefreshMinutes(
  globalValue: unknown,
  deviceValue: unknown,
): number {
  return (
    asRefreshMinutes(deviceValue) ??
    asRefreshMinutes(globalValue) ??
    CLIP_CATALOG_REFRESH_MINUTES_DEFAULT
  )
}

function asRefreshMinutes(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.round(value)
  if (rounded === CLIP_CATALOG_REFRESH_OFF) return CLIP_CATALOG_REFRESH_OFF
  if (rounded < CLIP_CATALOG_REFRESH_MINUTES_MIN) return null
  if (rounded > CLIP_CATALOG_REFRESH_MINUTES_MAX) return null
  return rounded
}

/** Is the operator's forced-wake switch on for this camera? */
export function resolveClipCatalogForcedWake(value: unknown): boolean {
  return value === true
}

/** One camera the timer is responsible for, with its cascade already applied. */
export interface ClipRefreshTarget {
  readonly deviceId: number
  /** The host whose lane this camera's reads share — one hub, one key. */
  readonly hostKey: string
  readonly isHubChild: boolean
  readonly isBattery: boolean
  readonly forcedWake: boolean
  /** Minutes, or {@link CLIP_CATALOG_REFRESH_OFF}. */
  readonly intervalMinutes: number
}

export interface ClipCatalogRefreshDeps {
  readonly now: () => number
  /** The cameras this addon owns, with their resolved settings. */
  listTargets(): readonly ClipRefreshTarget[]
  /** A real catalog read for the refresh window. Rejects when it could not. */
  refresh(deviceId: number): Promise<void>
  /** Age the catalog WITHOUT dropping it — "we have not checked lately" is
   *  not "this camera has no recordings" (D549 12). */
  markStale(deviceId: number): void
  /** The explicit, budgeted wake. Only ever reached from `forced-wake`. */
  wake(deviceId: number): Promise<void>
  /**
   * One bounded still-prefetch pass over the catalog the refresh just
   * confirmed. Reached ONLY after a listing that landed, and only on the two
   * shapes where a still is free (`clip-prefetch.ts`).
   */
  prefetchStills(deviceId: number): Promise<ClipPrefetchOutcome>
  /** True while an operator-facing read holds this host's lane. */
  hostBusy(hostKey: string): boolean
  readonly logger: IScopedLogger
}

/**
 * What a stopped prefetch pass puts on its line. Two shapes, one per branch:
 * a pass the camera refused reports what it managed first, a pass that threw
 * reports the error. Named rather than inline so neither branch can quietly
 * stop carrying what the other does.
 */
export type ClipPrefetchStopMeta =
  | {
      readonly branch: 'prefetch-refused'
      readonly mode: ClipPrefetchMode
      readonly minted: number
      readonly scanned: number
      readonly alreadyHeld: number
      readonly code: string | null
      readonly disposition: string | null
      readonly clipKey: string | null
    }
  | {
      readonly branch: 'prefetch-failed'
      readonly mode: ClipPrefetchMode
      readonly error: string
    }

/**
 * The timer. `tick()` is the whole surface, so a test drives it from COLD and
 * the scheduler owns no clock of its own — the addon supplies the interval.
 */
export class ClipCatalogRefreshScheduler {
  /** Last time an interval was SPENT on a camera, successful or not. */
  private readonly lastRunAt = new Map<number, number>()
  /** Cameras whose refresh has not come back yet. */
  private readonly inFlight = new Set<number>()
  /** Consecutive prefetch passes this camera stopped on a refusal. Cleared by
   *  the first pass that lands, so a camera that recovers is asked again on
   *  the very next tick. */
  private readonly prefetchRefusals = new Map<number, number>()
  /** Until when this camera's prefetch stays un-asked. */
  private readonly prefetchQuietUntil = new Map<number, number>()

  constructor(private readonly deps: ClipCatalogRefreshDeps) {}

  async tick(): Promise<void> {
    const now = this.deps.now()
    const due = this.deps.listTargets().filter((target) => this.isDue(target, now))
    // Sequential, not parallel: a hub's children share ONE socket, and the
    // library's CoverPreview lane is one-in-flight per host. Fanning out here
    // would queue behind itself and hold the lane for longer, not less.
    for (const target of due) {
      await this.run(target, now)
    }
  }

  private isDue(target: ClipRefreshTarget, now: number): boolean {
    if (target.intervalMinutes <= CLIP_CATALOG_REFRESH_OFF) return false
    if (this.inFlight.has(target.deviceId)) return false
    const last = this.lastRunAt.get(target.deviceId)
    if (last === undefined) return true
    return now - last >= target.intervalMinutes * 60_000
  }

  private async run(target: ClipRefreshTarget, now: number): Promise<void> {
    const tags = { deviceId: target.deviceId }
    const mode = resolveClipRefreshMode(target)

    // Interactive work has priority and the refresh yields — exactly the rule
    // the thumbnail prefetch is built on. NOT a spent interval: nothing was
    // asked of the camera, so the next tick tries again.
    if (this.deps.hostBusy(target.hostKey)) {
      this.deps.logger.warn('videoclips: catalog refresh deferred — the host is serving a read', {
        tags,
        meta: { branch: 'deferred-interactive', mode, host: target.hostKey },
      })
      return
    }

    if (mode === 'mark-stale') {
      // The honest whole of what a clock may do here. Logged at INFO rather
      // than dropped silently: "the timer ran and read nothing" is a branch
      // that declines work, and an operator asking why 640's catalog is old
      // must find the answer on a line.
      this.deps.markStale(target.deviceId)
      this.lastRunAt.set(target.deviceId, now)
      this.deps.logger.info(
        'videoclips: catalog marked stale — a timer cannot read a standalone battery camera',
        {
          tags,
          meta: {
            branch: 'mark-stale',
            mode,
            refreshesOn: 'onWakeTransition',
            intervalMinutes: target.intervalMinutes,
          },
        },
      )
      return
    }

    // The interval is spent BEFORE the attempt. On `forced-wake` that is the
    // whole point: a retry loop turns "every 15 minutes" into an unbounded
    // number of wakes on a battery camera, and a failed wake costs the camera
    // exactly as much as a successful one.
    this.lastRunAt.set(target.deviceId, now)
    this.inFlight.add(target.deviceId)
    try {
      if (mode === 'forced-wake') {
        try {
          await this.deps.wake(target.deviceId)
        } catch (err: unknown) {
          this.deps.markStale(target.deviceId)
          this.deps.logger.warn(
            'videoclips: the authorised wake did not bring the camera up — catalog left stale',
            {
              tags,
              meta: { branch: 'forced-wake-failed', mode, error: errMessage(err) },
            },
          )
          return
        }
      }
      await this.deps.refresh(target.deviceId)
      this.deps.logger.info('videoclips: catalog refreshed', {
        tags,
        meta: { branch: 'refreshed', mode, elapsedMs: this.deps.now() - now },
      })
      // Only now, and only here: the stills are for the rows that listing just
      // confirmed, so a pass before it would mint the catalog as it WAS and
      // miss exactly the newest clips the operator opens first.
      await this.prefetch(target, mode)
    } catch (err: unknown) {
      // A stale catalog must never look fresh. The cache stamps `catalogAsOf`
      // only on a listing that landed, so it already holds the last CONFIRMED
      // time; marking the rows stale is what makes the next READ retry.
      this.deps.markStale(target.deviceId)
      this.deps.logger.warn('videoclips: catalog refresh failed — the catalog stays as it was', {
        tags,
        meta: { branch: 'refresh-failed', mode, error: errMessage(err) },
      })
    } finally {
      this.inFlight.delete(target.deviceId)
    }
  }

  /**
   * The still prefetch for a camera whose catalog was just re-read.
   *
   * It NEVER throws — a prefetch is an enhancement to a refresh that already
   * landed, and letting it reach the refresh's own catch would mark a catalog
   * stale that is not. Every exit says which branch it took, per camera.
   */
  private async prefetch(target: ClipRefreshTarget, mode: ClipPrefetchMode): Promise<void> {
    const deviceId = target.deviceId
    const tags = { deviceId }
    const quietUntil = this.prefetchQuietUntil.get(deviceId) ?? 0
    const decision = decideClipPrefetch({
      mode,
      // Asked AGAIN: the refresh is not instantaneous, and the operator who
      // took the lane during it must not queue behind a prefetch.
      hostBusy: this.deps.hostBusy(target.hostKey),
      quiet: quietUntil > this.deps.now(),
    })
    if (decision.kind === 'skip') {
      this.deps.logger.info('videoclips: still prefetch skipped', {
        tags,
        meta: {
          branch: `prefetch-${decision.reason}`,
          mode,
          host: target.hostKey,
          quietForMs: Math.max(0, quietUntil - this.deps.now()),
        },
      })
      return
    }

    try {
      const outcome = await this.deps.prefetchStills(deviceId)
      if (outcome.stop === 'refused') {
        this.quieten(target, {
          branch: 'prefetch-refused',
          mode,
          minted: outcome.minted,
          scanned: outcome.scanned,
          alreadyHeld: outcome.alreadyHeld,
          code: outcome.refusal?.code ?? null,
          disposition: outcome.refusal?.disposition ?? null,
          clipKey: outcome.refusal?.clipKey ?? null,
        })
        return
      }
      this.prefetchRefusals.delete(deviceId)
      this.prefetchQuietUntil.delete(deviceId)
      this.deps.logger.info('videoclips: stills prefetched', {
        tags,
        meta: {
          branch: `prefetch-${outcome.stop}`,
          mode,
          minted: outcome.minted,
          scanned: outcome.scanned,
          alreadyHeld: outcome.alreadyHeld,
        },
      })
    } catch (err: unknown) {
      // A pass that threw is a host that is not serving stills, which is the
      // same fact as a pass that was refused — and the same ladder, or a
      // thrown lane would be retried on every tick for ever.
      this.quieten(target, { branch: 'prefetch-failed', mode, error: errMessage(err) })
    }
  }

  /** Arm the doubling quiet period and say so, with what the pass reported. */
  private quieten(target: ClipRefreshTarget, meta: ClipPrefetchStopMeta): void {
    const deviceId = target.deviceId
    const refusals = (this.prefetchRefusals.get(deviceId) ?? 0) + 1
    this.prefetchRefusals.set(deviceId, refusals)
    const quietForMs = prefetchQuietMs(refusals, target.intervalMinutes * 60_000)
    this.prefetchQuietUntil.set(deviceId, this.deps.now() + quietForMs)
    this.deps.logger.warn('videoclips: still prefetch stopped — the host is not serving stills', {
      tags: { deviceId },
      meta: { ...meta, host: target.hostKey, consecutiveRefusals: refusals, quietForMs },
    })
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
