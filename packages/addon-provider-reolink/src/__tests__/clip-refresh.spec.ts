/**
 * The clip-catalog refresh — the timer, its per-topology rule, and its cascade.
 *
 * ## Why every assertion here starts COLD
 *
 * The defect this line of work just closed (D561) was invisible to a whole
 * spec file because every test called `listClips` before reading
 * `listSources`, so all of them pinned a WARM in-process map and none of them
 * asked the question a surface asks — first, before anything has run. A timer
 * is the same trap one level up: a scheduler asserted after a manual refresh
 * proves the manual refresh. So every test below constructs the scheduler and
 * ticks it with nothing having happened, and the fakes record what the tick
 * ITSELF caused.
 *
 * The fleet these rules were written against (enumerated live 2026-09-20, not
 * assumed): mains standalone 592 / 618; standalone battery 640 / 4263; hub
 * children 3628 / 3629 / 3825, all battery, all served by their parent; and
 * the Home Hub 639, which is `type: hub` and therefore never a `videoclips`
 * device at all — its catalog IS its children's, refreshed per child on its
 * one session. Accessories (sirens, floodlights, PIR switches) are not
 * cameras and never bind the cap.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ClipPrefetchOutcome } from '../clips/clip-prefetch.js'
import {
  CLIP_CATALOG_REFRESH_MINUTES_DEFAULT,
  CLIP_CATALOG_REFRESH_OFF,
  type ClipCatalogRefreshDeps,
  ClipCatalogRefreshScheduler,
  type ClipRefreshTarget,
  resolveClipCatalogRefreshMinutes,
  resolveClipRefreshMode,
} from '../clips/clip-refresh.js'
import { createRecordingLogger } from './clip-test-logger.js'

/**
 * A prefetch pass that found nothing to do. This file is about the REFRESH;
 * the prefetch it now drags behind it has its own spec next door
 * (`clip-prefetch-is-wired.spec.ts`), and a fake that refused here would quietly
 * arm the quiet ladder inside every scenario below.
 */
const LANDED: ClipPrefetchOutcome = {
  minted: 0,
  scanned: 0,
  alreadyHeld: 0,
  stop: 'rows-exhausted',
  refusal: null,
}

const NOW = Date.parse('2026-09-20T12:00:00Z')
const MINUTE = 60_000

/** 592 / 618 — mains, its own socket. */
const MAINS_STANDALONE: ClipRefreshTarget = {
  deviceId: 107,
  hostKey: '192.168.10.161',
  isHubChild: false,
  isBattery: false,
  forcedWake: false,
  intervalMinutes: 30,
}
/** 3628 / 3629 / 3825 — battery, but read through the parent's open session. */
const HUB_CHILD: ClipRefreshTarget = {
  deviceId: 3628,
  hostKey: '192.168.10.170',
  isHubChild: true,
  isBattery: true,
  forcedWake: false,
  intervalMinutes: 30,
}
/** 640 / 4263 — standalone battery. Every direct read is a login, and the
 *  login IS the wake. */
const BATTERY_STANDALONE: ClipRefreshTarget = {
  deviceId: 106,
  hostKey: '192.168.10.181',
  isHubChild: false,
  isBattery: true,
  forcedWake: false,
  intervalMinutes: 30,
}

interface HarnessOptions {
  readonly targets?: readonly ClipRefreshTarget[]
  readonly busyHosts?: ReadonlySet<string>
  readonly refreshFails?: boolean
  readonly wakeFails?: boolean
}

function harness(options: HarnessOptions = {}) {
  let now = NOW
  const refresh = vi.fn(async (_deviceId: number) => {
    if (options.refreshFails === true) throw new Error('Baichuan socket closed')
  })
  const wake = vi.fn(async (_deviceId: number) => {
    if (options.wakeFails === true) throw new Error('the camera did not come up')
  })
  const markStale = vi.fn()
  const prefetchStills = vi.fn(async (_deviceId: number) => LANDED)
  const logger = createRecordingLogger()
  const deps: ClipCatalogRefreshDeps = {
    now: () => now,
    listTargets: () => options.targets ?? [MAINS_STANDALONE],
    refresh,
    wake,
    markStale,
    prefetchStills,
    hostBusy: (hostKey) => options.busyHosts?.has(hostKey) ?? false,
    logger,
  }
  return {
    scheduler: new ClipCatalogRefreshScheduler(deps),
    refresh,
    wake,
    markStale,
    prefetchStills,
    logger,
    warns: logger.warns,
    infos: logger.infos,
    advance: (ms: number) => {
      now += ms
    },
  }
}

// ── the rule, per topology ────────────────────────────────────────────────

describe('resolveClipRefreshMode — the cost differs by an order of magnitude', () => {
  it('reads a hub child THROUGH THE HUB, even though the child is a battery camera', () => {
    // Measured 65 ms on 3628, on the parent's already-open session with the
    // child's uid. The child never hears it, so a periodic refresh here is
    // pure gain — this is the one case where the timer earns its keep.
    expect(resolveClipRefreshMode({ isHubChild: true, isBattery: true, forcedWake: false })).toBe(
      'via-hub',
    )
  })

  it('reads a MAINS hub child through the hub too — the route is the parent, not the battery', () => {
    // No such camera on this fleet today (every child of 639 is battery), but
    // a wired camera under a hub or NVR is a Reolink shape that exists. The
    // branch must be the TOPOLOGY, not the power source: reading a child
    // directly would be a second session to the hub, which produced 27
    // ECONNRESETs (D549 17). Ordering the battery test first would silently
    // send this camera down `direct`.
    expect(resolveClipRefreshMode({ isHubChild: true, isBattery: false, forcedWake: false })).toBe(
      'via-hub',
    )
  })

  it('reads a mains standalone directly', () => {
    expect(resolveClipRefreshMode({ isHubChild: false, isBattery: false, forcedWake: false })).toBe(
      'direct',
    )
  })

  it('only MARKS a standalone battery camera stale — a timer cannot refresh it', () => {
    // Every direct read is a login and the login IS the wake. The real refresh
    // hangs off `onWakeTransition`, which fires when the camera confirms itself
    // awake for its own reasons.
    expect(resolveClipRefreshMode({ isHubChild: false, isBattery: true, forcedWake: false })).toBe(
      'mark-stale',
    )
  })

  it('wakes a standalone battery camera ONLY when the operator asked for it', () => {
    expect(resolveClipRefreshMode({ isHubChild: false, isBattery: true, forcedWake: true })).toBe(
      'forced-wake',
    )
  })

  it('ignores forcedWake where it would mean nothing', () => {
    // A hub child and a mains camera are never woken by this timer, so the
    // switch must not change what they do — a knob that silently means two
    // things on two cameras is the defect the description exists to prevent.
    expect(resolveClipRefreshMode({ isHubChild: true, isBattery: true, forcedWake: true })).toBe(
      'via-hub',
    )
    expect(resolveClipRefreshMode({ isHubChild: false, isBattery: false, forcedWake: true })).toBe(
      'direct',
    )
  })
})

// ── the cascade ───────────────────────────────────────────────────────────

describe('resolveClipCatalogRefreshMinutes — reset == unset == the default', () => {
  it('falls back to the default when nothing is set anywhere', () => {
    expect(resolveClipCatalogRefreshMinutes(undefined, undefined)).toBe(
      CLIP_CATALOG_REFRESH_MINUTES_DEFAULT,
    )
  })

  it('takes the global when the device has no override', () => {
    expect(resolveClipCatalogRefreshMinutes(45, undefined)).toBe(45)
  })

  it('lets the device override the global', () => {
    expect(resolveClipCatalogRefreshMinutes(45, 120)).toBe(120)
  })

  it('treats an UNSET device override exactly like a RESET one', () => {
    expect(resolveClipCatalogRefreshMinutes(45, null)).toBe(45)
    expect(resolveClipCatalogRefreshMinutes(45, '')).toBe(45)
  })

  it('never throws on a bad blob — an invalid value resolves to the level above', () => {
    expect(resolveClipCatalogRefreshMinutes('nonsense', { deep: true })).toBe(
      CLIP_CATALOG_REFRESH_MINUTES_DEFAULT,
    )
    expect(resolveClipCatalogRefreshMinutes(45, -5)).toBe(45)
  })

  it('keeps OFF as a real, settable value at both levels', () => {
    expect(resolveClipCatalogRefreshMinutes(CLIP_CATALOG_REFRESH_OFF, undefined)).toBe(
      CLIP_CATALOG_REFRESH_OFF,
    )
    expect(resolveClipCatalogRefreshMinutes(45, CLIP_CATALOG_REFRESH_OFF)).toBe(
      CLIP_CATALOG_REFRESH_OFF,
    )
  })
})

// ── the timer, asserted COLD ──────────────────────────────────────────────

describe('the scheduler, from cold', () => {
  it('refreshes a mains standalone on its first tick', async () => {
    const { scheduler, refresh } = harness()
    await scheduler.tick()
    expect(refresh).toHaveBeenCalledWith(107)
  })

  it('refreshes a hub child through the hub, and never wakes it', async () => {
    const { scheduler, refresh, wake } = harness({ targets: [HUB_CHILD] })
    await scheduler.tick()
    expect(refresh).toHaveBeenCalledWith(3628)
    expect(wake).not.toHaveBeenCalled()
  })

  it('only marks a standalone battery camera stale, and never reads it', async () => {
    const { scheduler, refresh, wake, markStale, infos } = harness({
      targets: [BATTERY_STANDALONE],
    })
    await scheduler.tick()
    expect(refresh).not.toHaveBeenCalled()
    expect(wake).not.toHaveBeenCalled()
    expect(markStale).toHaveBeenCalledWith(106)
    const line = infos.find((l) => JSON.stringify(l.extras).includes('mark-stale'))
    expect(line?.extras.tags).toMatchObject({ deviceId: 106 })
  })

  it('does nothing at all when the interval is OFF, and says which device', async () => {
    const { scheduler, refresh, markStale } = harness({
      targets: [{ ...MAINS_STANDALONE, intervalMinutes: CLIP_CATALOG_REFRESH_OFF }],
    })
    await scheduler.tick()
    expect(refresh).not.toHaveBeenCalled()
    expect(markStale).not.toHaveBeenCalled()
  })

  it('does not run again before the interval has passed', async () => {
    const { scheduler, refresh, advance } = harness()
    await scheduler.tick()
    advance(29 * MINUTE)
    await scheduler.tick()
    expect(refresh).toHaveBeenCalledTimes(1)
    advance(2 * MINUTE)
    await scheduler.tick()
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('DEFERS to an interactive read on the same host, and says so', async () => {
    // The refresh shares the library's single CoverPreview lane and its
    // host-keyed backoff, and the hub's one socket. An operator staring at a
    // tile must never wait behind a timer.
    const { scheduler, refresh, warns } = harness({
      busyHosts: new Set(['192.168.10.161']),
    })
    await scheduler.tick()
    expect(refresh).not.toHaveBeenCalled()
    const line = warns.find((w) => JSON.stringify(w.extras).includes('deferred-interactive'))
    expect(line).toBeDefined()
    expect(line?.extras.tags).toMatchObject({ deviceId: 107 })
  })

  it('retries a DEFERRED device on the very next tick — a deferral is not a run', async () => {
    let busy = true
    const logger = createRecordingLogger()
    const refresh = vi.fn(async (_deviceId: number) => {})
    const scheduler = new ClipCatalogRefreshScheduler({
      now: () => NOW,
      listTargets: () => [MAINS_STANDALONE],
      refresh,
      wake: async () => {},
      markStale: () => {},
      prefetchStills: async () => LANDED,
      hostBusy: () => busy,
      logger,
    })
    await scheduler.tick()
    expect(refresh).not.toHaveBeenCalled()
    busy = false
    await scheduler.tick()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('never runs two refreshes of one camera at once', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const refresh = vi.fn(async (_deviceId: number) => await gate)
    const scheduler = new ClipCatalogRefreshScheduler({
      now: () => NOW,
      listTargets: () => [MAINS_STANDALONE],
      refresh,
      wake: async () => {},
      markStale: () => {},
      prefetchStills: async () => LANDED,
      hostBusy: () => false,
      logger: createRecordingLogger(),
    })
    const first = scheduler.tick()
    await scheduler.tick()
    release()
    await first
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})

// ── a failure must not look like a success ────────────────────────────────

describe('a refresh that FAILED', () => {
  it('leaves the catalog stale and says so, instead of looking fresh', async () => {
    // `catalogAsOf` is the honest field. The cache only stamps it on a
    // SUCCESSFUL listing, so a failed refresh must leave it at the last
    // CONFIRMED time — and mark the rows stale so the next read retries.
    const { scheduler, markStale, warns } = harness({ refreshFails: true })
    await scheduler.tick()
    expect(markStale).toHaveBeenCalledWith(107)
    const line = warns.find((w) => JSON.stringify(w.extras).includes('refresh-failed'))
    expect(line).toBeDefined()
    expect(line?.extras.tags).toMatchObject({ deviceId: 107 })
    expect(JSON.stringify(line?.extras)).toContain('Baichuan socket closed')
  })

  it('does not retry inside the same interval — one interval is one attempt', async () => {
    const { scheduler, refresh, advance } = harness({ refreshFails: true })
    await scheduler.tick()
    advance(MINUTE)
    await scheduler.tick()
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})

// ── the forced wake ───────────────────────────────────────────────────────

describe('clipCatalogForcedWake — off by default, and budgeted when on', () => {
  it('is off by default, so the timer never wakes 640', async () => {
    const { scheduler, wake } = harness({ targets: [BATTERY_STANDALONE] })
    await scheduler.tick()
    expect(wake).not.toHaveBeenCalled()
  })

  it('wakes and then refreshes when the operator turned it on', async () => {
    const { scheduler, wake, refresh } = harness({
      targets: [{ ...BATTERY_STANDALONE, forcedWake: true }],
    })
    await scheduler.tick()
    expect(wake).toHaveBeenCalledWith(106)
    expect(refresh).toHaveBeenCalledWith(106)
  })

  it('spends ONE wake per authorised interval, even when the wake fails', async () => {
    // A retry loop turns an operator's "every 15 minutes" into an unbounded
    // wake count on a battery camera. The interval is stamped BEFORE the
    // attempt, so a failure costs the same one wake a success does.
    const { scheduler, wake, advance, warns } = harness({
      targets: [{ ...BATTERY_STANDALONE, forcedWake: true, intervalMinutes: 15 }],
      wakeFails: true,
    })
    await scheduler.tick()
    advance(MINUTE)
    await scheduler.tick()
    advance(MINUTE)
    await scheduler.tick()
    expect(wake).toHaveBeenCalledTimes(1)
    expect(warns.some((w) => JSON.stringify(w.extras).includes('forced-wake-failed'))).toBe(true)
    advance(14 * MINUTE)
    await scheduler.tick()
    expect(wake).toHaveBeenCalledTimes(2)
  })

  it('leaves the catalog stale when a forced wake could not read it', async () => {
    const { scheduler, markStale } = harness({
      targets: [{ ...BATTERY_STANDALONE, forcedWake: true }],
      wakeFails: true,
    })
    await scheduler.tick()
    expect(markStale).toHaveBeenCalledWith(106)
  })
})

// ── every line about a camera names the camera ────────────────────────────

describe('logging', () => {
  it('tags every line with its deviceId, on every branch', async () => {
    const { scheduler, logger } = harness({
      targets: [
        MAINS_STANDALONE,
        HUB_CHILD,
        BATTERY_STANDALONE,
        { ...BATTERY_STANDALONE, deviceId: 4263, forcedWake: true },
      ],
    })
    await scheduler.tick()
    const lines = [...logger.infos, ...logger.warns]
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line.extras.tags).toMatchObject({ deviceId: expect.any(Number) })
    }
  })
})
