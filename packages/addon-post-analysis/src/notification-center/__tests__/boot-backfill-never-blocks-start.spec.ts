/**
 * A PRODUCER'S BOOT BACK-FILL MUST NOT HOLD THE ADDON'S initialize().
 *
 * ## The outage this pins
 *
 * 2026-08-14, hub dev. The admin UI: "Failed to load rules — Capability
 * notification-rules provider not available". `listCapabilityProviders` was
 * EMPTY for all eight capabilities `pipeline-analytics` declares, on all three
 * nodes. The runner itself was alive and chatty — its 30 s rule-reload tick
 * logged throughout — which is exactly why nothing looked broken.
 *
 * The chain: `addon-runner` publishes a child's capability manifest only after
 * `await addon.initialize(context)` RETURNS. `initialize()` awaited
 * `NotificationCenter.start()`, which awaited `TimelapseScheduler.start()`,
 * whose boot back-fill is a full `tick()` — and a tick RENDERS VIDEO, sitting in
 * `awaitReady` for up to `RENDER_TIMEOUT_MS` (30 min) per (rule, camera) pair.
 * A nightly 19:00→05:00 window came due at boot; the export was still at 0%
 * half an hour later. For that whole time the cluster had no provider for
 * `notification-rules`, `pipeline-analytics`, `zone-analytics`, `audio-metrics`,
 * `videoclips`, `face-gallery`, `plate-gallery` or that addon's widgets.
 *
 * ## What is asserted, and how the negative is proved
 *
 * "start() does not block" cannot be asserted by waiting and hoping. Each test
 * hands the producer a boot pass that NEVER settles (a render / a mosaic build
 * that returns a promise nobody resolves) and then awaits `start()`. If the
 * back-fill were awaited, `start()` could not resolve at all and the test times
 * out — which is the failure mode, reproduced exactly.
 *
 * The interval assertion is the other half: `start()` must still leave the
 * producer RUNNING, or "does not block" would be satisfied by doing nothing.
 */
import { ncRecordKinds } from '../record-kinds.js'
import { makeNcRecords } from './support/nc-test-deps.js'
import type { TimelapseRule } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcSummaryCollector } from '../summary/summary-collector.js'
import { NcSummaryProducer } from '../summary/summary-producer.js'
import { NcSummaryRuleInputSchema } from '../summary/summary-rule.js'
import { NcSummaryStore } from '../summary/summary-store.js'
import { TimelapseScheduler } from '../timelapse/timelapse-scheduler.js'
import { TimelapseStore } from '../timelapse/timelapse-store.js'

/** Mon 2026-01-05, nightly 22:00→06:00 UTC — the same fixture week the
 *  scheduler's own spec uses, so "a window has closed" needs no re-derivation. */
const MON = Date.UTC(2026, 0, 5)
const at = (dayOffset: number, hour: number): number =>
  MON + dayOffset * 86_400_000 + hour * 3600_000
const NIGHTLY = {
  windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 22 * 60, endMinute: 6 * 60 }],
  timezone: 'UTC',
}
/** Well past the closed window's settle delay. */
const NOW = at(1, 12)
/** The rule was born before the window it is offered. */
const CREATED_BEFORE = at(-1, 12)

/** A promise that never settles — the boot pass that wedged the live hub. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

/** `start()` must resolve; anything else is the bug. Bounded so a regression
 *  fails as a timeout on THIS assertion rather than the whole file. */
async function withinBound(started: Promise<void>): Promise<void> {
  await Promise.race([
    started,
    new Promise<never>((_, reject) => {
      const t = setTimeout(
        () => reject(new Error('start() did not resolve — the boot back-fill is being awaited')),
        2_000,
      )
      t.unref?.()
    }),
  ])
}

const stopFns: Array<() => void> = []

afterEach(() => {
  for (const stop of stopFns) stop()
  stopFns.length = 0
  vi.useRealTimers()
})

describe('TimelapseScheduler.start', () => {
  it('resolves while the back-fill render is still in flight', async () => {
    const world = makeNcRecords()
    let now = CREATED_BEFORE
    const store = new TimelapseStore({
      kind: world.records.kind(ncRecordKinds['timelapse-rules']),
      logger: makeSilentLogger(),
      now: () => now,
      newId: () => 'tl-1',
    })
    const rule: TimelapseRule = await store.create(
      {
        name: 'Notte retro',
        enabled: true,
        deviceIds: [1441],
        schedule: NIGHTLY,
        cadenceSec: 30,
        framerate: 12,
        targets: [{ targetId: 'zentik' }],
        priority: 3,
        previewMode: 'image',
      },
      'admin',
    )
    now = NOW

    // The render the live hub was stuck on: queued, 0%, never ready.
    const render = vi.fn((_req: { ruleId: string; deviceId: number }) => never<never>())
    const scheduler = new TimelapseScheduler({
      logger: makeSilentLogger(),
      now: () => now,
      store,
      render,
      enqueue: async () => 1,
      tickMs: 3_600_000,
    })
    stopFns.push(() => scheduler.stop())

    await withinBound(scheduler.start())

    // And it really did start the pass — otherwise "did not block" would be
    // satisfied by a producer that does nothing at all.
    expect(render).toHaveBeenCalledTimes(1)
    expect(render.mock.calls[0]?.[0]).toMatchObject({ ruleId: rule.id, deviceId: 1441 })
  })

  it('arms the interval even though the back-fill has not finished', async () => {
    vi.useFakeTimers()
    const world = makeNcRecords()
    const store = new TimelapseStore({
      kind: world.records.kind(ncRecordKinds['timelapse-rules']),
      logger: makeSilentLogger(),
      now: () => NOW,
      newId: () => 'tl-1',
    })
    const scheduler = new TimelapseScheduler({
      logger: makeSilentLogger(),
      now: () => NOW,
      store,
      render: () => never<never>(),
      enqueue: async () => 1,
      tickMs: 1_000,
    })
    stopFns.push(() => scheduler.stop())
    const tick = vi.spyOn(scheduler, 'tick')

    await scheduler.start()
    await vi.advanceTimersByTimeAsync(2_500)

    // The boot pass plus the interval passes — a producer whose start() no
    // longer waits must still be a producer that keeps producing.
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(3)
  })
})

describe('NcSummaryProducer.start', () => {
  /**
   * The digest producer's boot pass renders a mosaic and publishes it, which is
   * the same unbounded shape as the timelapse render. Its `tick()` needs a
   * collector, tracks and media to reach that point, and none of that is what
   * is under test here — the contract is `start()` fires the boot tick and does
   * NOT wait on it. So the tick itself is the hanging thing, directly.
   */
  it('resolves while the back-fill digest is still in flight', async () => {
    const world = makeNcRecords()
    const store = new NcSummaryStore({
      kind: world.records.kind(ncRecordKinds['summary-rules']),
      logger: makeSilentLogger(),
      now: () => NOW,
      newId: () => 'sum-1',
    })
    await store.create(
      NcSummaryRuleInputSchema.parse({
        name: 'Digest notte',
        deviceIds: [1441],
        window: { kind: 'motion', quietSeconds: 300, maxWindowSeconds: 1_800 },
        targets: [{ targetId: 'zentik' }],
        barrierSeconds: 120,
      }),
      'admin',
    )

    const producer = new NcSummaryProducer({
      logger: makeSilentLogger(),
      now: () => NOW,
      store,
      collector: new NcSummaryCollector(),
      listTracks: async () => [],
      listMediaInfo: async () => [],
      readMedia: async () => null,
      enqueue: async () => 1,
      getDeviceName: async () => 'Camera',
      publish: async () => ({ url: null, artifactId: null }),
      tickMs: 3_600_000,
    })
    stopFns.push(() => producer.stop())
    const tick = vi.spyOn(producer, 'tick').mockReturnValue(never())

    await withinBound(producer.start())

    expect(tick).toHaveBeenCalledTimes(1)
  })
})
