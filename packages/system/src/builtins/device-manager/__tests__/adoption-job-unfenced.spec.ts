/**
 * An operator re-adopting hardware they just deleted must not meet the fence.
 *
 * Reported 2026-09-16: a Dreame vacuum deleted and immediately re-adopted
 * failed with `dreame adopt: all 1 adopt(s) failed`, and the hub said exactly
 * why — `allocateDeviceId refused — this device was just removed, NOT
 * re-created`, `device 318 (provider-dreame/dreame:int_0009:2045106661)`.
 *
 * `removal-fence.ts` already states the intent: "A deliberate re-add of the
 * same hardware (`createDevice` / `adoptDevice`) lifts the fence for that pair
 * explicitly, so an operator is never told 'no' for their own action."
 *
 * There are TWO adoption paths and only one of them honours that.
 * `adoptDevice` wraps the provider call in `runUnfenced`; `adoptionStartJob`
 * hands the work to this engine and never mentions the fence — so every
 * integration driven by adoption JOBS refuses a re-add for the whole 5-minute
 * TTL. It is not a Dreame defect.
 *
 * And the suspension could not have worked from the caller anyway:
 * `runUnfenced` is a COUNTER raised for the duration of an awaited call, while
 * `start()` returns a jobId immediately and the adopting happens on a detached
 * promise. Wrapping `start()` would lower the fence for the microseconds it
 * takes to hand back an id. The suspension has to live where the provider is
 * actually called — around each candidate.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

import type { AdoptionJobProvider, AdoptResult } from '../adoption-job-engine.js'
import { AdoptionJobEngine } from '../adoption-job-engine.js'
import { createRemovalFence } from '../removal-fence.js'

function makeLogger(): IScopedLogger {
  const l = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
  }
  return l as unknown as IScopedLogger
}

const ADDON = 'provider-dreame'
const STABLE = 'dreame:int_0009:2045106661'

/**
 * A provider that does what the real one does: while adopting, it asks the
 * device-manager to allocate an id for the pair — which is where the fence is
 * consulted. It records the answer it got.
 */
function makeProvider(fenceSeenBy: string[], fence: ReturnType<typeof createRemovalFence>) {
  const provider: AdoptionJobProvider = {
    listCandidates: async () => ({ candidates: [], totalCount: 0 }),
    adopt: async (input): Promise<AdoptResult> => {
      const child = input.childNativeIds[0] ?? ''
      // EXACTLY what `allocateDeviceId` does on the hub.
      if (fence.isPairFenced(ADDON, STABLE) !== null) {
        fenceSeenBy.push(child)
        throw new Error('was removed — refusing to re-create it')
      }
      return {
        adopted: [{ childNativeId: child, parentDeviceId: 318, accessoryDeviceIds: [] }],
      }
    },
  }
  return provider
}

describe('an adoption job is the operator’s own action', () => {
  it('adopts a device that was deleted seconds ago', async () => {
    const fence = createRemovalFence()
    fence.record({ deviceId: 318, addonId: ADDON, stableId: STABLE })
    const blocked: string[] = []
    const engine = new AdoptionJobEngine({
      resolveProvider: async () => makeProvider(blocked, fence),
      logger: makeLogger(),
      removalFence: fence,
    })

    const { jobId } = await engine.start({
      addonId: ADDON,
      integrationId: 'int_0009',
      childNativeIds: ['2045106661'],
    })
    await engine.waitForTest(jobId)

    expect(blocked).toEqual([])
    const job = engine.get(jobId)
    expect(job?.results[0]?.outcome).toBe('adopted')
    expect(job?.results[0]?.error ?? null).toBeNull()
  })

  /**
   * The fence must come back UP afterwards. Suspending it for the life of the
   * job — or forgetting to restore it — would re-open the race D376 records:
   * a teardown still in flight putting the row back as a config-less shell.
   */
  it('puts the fence back the moment the job is done', async () => {
    const fence = createRemovalFence()
    fence.record({ deviceId: 318, addonId: ADDON, stableId: STABLE })
    const engine = new AdoptionJobEngine({
      resolveProvider: async () => makeProvider([], fence),
      logger: makeLogger(),
      removalFence: fence,
    })
    const { jobId } = await engine.start({
      addonId: ADDON,
      integrationId: 'int_0009',
      childNativeIds: ['2045106661'],
    })
    await engine.waitForTest(jobId)
    expect(fence.isPairFenced(ADDON, STABLE)).not.toBeNull()
  })

  /** A provider that throws must not leave the fence down either. */
  it('puts the fence back even when the candidate fails', async () => {
    const fence = createRemovalFence()
    fence.record({ deviceId: 318, addonId: ADDON, stableId: STABLE })
    const engine = new AdoptionJobEngine({
      resolveProvider: async () => ({
        listCandidates: async () => ({ candidates: [], totalCount: 0 }),
        adopt: async () => {
          throw new Error('the vacuum said no')
        },
      }),
      logger: makeLogger(),
      removalFence: fence,
    })
    const { jobId } = await engine.start({
      addonId: ADDON,
      integrationId: 'int_0009',
      childNativeIds: ['2045106661'],
    })
    await engine.waitForTest(jobId)
    expect(fence.isPairFenced(ADDON, STABLE)).not.toBeNull()
  })

  /** Absent fence ⇒ exactly the old behaviour. Nothing else has to change. */
  it('runs unchanged when no fence is wired', async () => {
    const engine = new AdoptionJobEngine({
      resolveProvider: async () => ({
        listCandidates: async () => ({ candidates: [], totalCount: 0 }),
        adopt: async (input) => ({
          adopted: [
            {
              childNativeId: input.childNativeIds[0] ?? '',
              parentDeviceId: 7,
              accessoryDeviceIds: [],
            },
          ],
        }),
      }),
      logger: makeLogger(),
    })
    const { jobId } = await engine.start({
      addonId: ADDON,
      integrationId: 'int_0009',
      childNativeIds: ['x'],
    })
    await engine.waitForTest(jobId)
    expect(engine.get(jobId)?.results[0]?.outcome).toBe('adopted')
  })
})
