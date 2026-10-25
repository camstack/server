/**
 * `buildNotificationCenter` MUST NOT HOLD `initialize()`.
 *
 * The measurement this exists for, live hub 2026-08-17 at ZERO transport
 * contention (one UDS timeout in the entire boot, so it was work and internal
 * waits, not a queue):
 *
 *   pipeline-analytics boot step  step=buildNotificationCenter  ms=270_000
 *
 * `addon-runner` appends a child's manifest entry only AFTER
 * `await addon.initialize(context)` returns, so for those 270 s the cluster had
 * no provider for `notification-rules`, `pipeline-analytics`, `zone-analytics`,
 * `audio-metrics`, `videoclips`, `face-gallery` or `plate-gallery` — the exact
 * blast radius of the 2026-08-14 timelapse incident, from a different await.
 *
 * Every second of it was durable back-fill inside `NotificationCenter.start()`:
 * the liveness ledger reseed (775 subjects), the outbox hydration (743 rows),
 * the cooldown seed, and two N+1 per-device refresh loops (`readDeviceStates`
 * and `readDeviceZoneIds` issue one RPC per watched device, serially).
 *
 * This spec pins the boundary rather than the mechanism: hold the store's read
 * of ONE notification-centre collection open forever and require the addon to
 * boot anyway. A regression fails as a timeout on the boot budget, which is
 * exactly how the live failure presented.
 *
 * The companion unit spec is `notification-center/__tests__/
 * start-does-not-wait-for-the-backfill.spec.ts`, which pins what the back-fill
 * must not cost once it is off the critical path (no loss, no duplicate).
 */
import type { SettingsStoreClient } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { NC_LIVENESS_COLLECTION } from '../../notification-center/liveness-ledger.js'
import { NC_OUTBOX_COLLECTION } from '../../notification-center/outbox.js'
import { bootAnalytics } from './boot-analytics.js'

/** Generous, but finite. The live step was 270 s; anything in this
 *  neighbourhood proves the back-fill is not being awaited. */
const BOOT_BUDGET_MS = 5_000

/** A store whose reads of ONE collection never answer — the 50 s query, taken
 *  to its limit so the assertion cannot be satisfied by a fast machine. */
function withHangingReadsOf(collection: string) {
  return (inner: SettingsStoreClient): SettingsStoreClient => ({
    ...inner,
    query: {
      ...inner.query,
      query: async (input: Parameters<SettingsStoreClient['query']['query']>[0]) => {
        if (input.collection === collection) await new Promise<void>(() => {})
        return inner.query.query(input)
      },
    },
  })
}

async function bootWithHangingCollection(collection: string): Promise<number> {
  const started = Date.now()
  const booted = await bootAnalytics(101, async () => null, {
    wrapSettingsStore: withHangingReadsOf(collection),
  })
  const elapsed = Date.now() - started
  // The whole point: the manifest is publishable, so every capability this
  // addon declares is registered instead of absent.
  expect(booted.addon).toBeDefined()
  await booted.addon.shutdown()
  return elapsed
}

describe('the notification centre at boot', () => {
  it('initialize() RESOLVES while the OUTBOX hydration never answers', async () => {
    expect(await bootWithHangingCollection(NC_OUTBOX_COLLECTION)).toBeLessThan(BOOT_BUDGET_MS)
  }, 20_000)

  it('initialize() RESOLVES while the LIVENESS reseed never answers', async () => {
    expect(await bootWithHangingCollection(NC_LIVENESS_COLLECTION)).toBeLessThan(BOOT_BUDGET_MS)
  }, 20_000)

  it('the centre reports it started, and reports the back-fill as ARMED', async () => {
    const booted = await bootAnalytics(101, async () => null, {
      wrapSettingsStore: withHangingReadsOf(NC_OUTBOX_COLLECTION),
    })
    const started = booted.logs.find((line) => line.message === 'notification center started')
    expect(started).toBeDefined()
    // Named out loud, because "started" used to mean "hydrated" and the two
    // are different claims now. A boot log that still promised the second
    // would be the leftover that reads as verification.
    expect((started?.extras as { meta?: { backfill?: string } } | undefined)?.meta?.backfill).toBe(
      'armed',
    )
    await booted.addon.shutdown()
  }, 20_000)
})
