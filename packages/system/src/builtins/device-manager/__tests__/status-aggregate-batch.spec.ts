/**
 * The batched status aggregate — what a camera list asks for in ONE call.
 *
 * The behaviour under test is not "it returns values"; it is what happens when
 * one device misbehaves. The single-device aggregate already yields `null` for
 * a cap whose provider throws so the rest of the device stays usable, and this
 * must extend that rule ACROSS devices: one bad camera cannot blank the other
 * nine, and it must still occupy a key — a caller that read a missing key as
 * "not answered yet" would keep a stale badge on screen indefinitely.
 */
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { getDeviceStatusAggregateBatch } from '../device-aggregation.js'

interface FakeProvider {
  getStatus: (input: { deviceId: number }) => Promise<unknown>
}

const BATTERY_SCHEMA = z.object({ percentage: z.number() })

function makeDeps(
  providers: Readonly<Record<string, FakeProvider | null>>,
  onGetProvider?: (capName: string, deviceId: number) => void,
): Parameters<typeof getDeviceStatusAggregateBatch>[0] {
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const registry = {
    getDefinition: (name: string) =>
      name === 'battery' ? { status: { schema: BATTERY_SCHEMA } } : null,
    getProviderForDevice: (capName: string, deviceId: number) => {
      onGetProvider?.(capName, deviceId)
      return providers[capName] ?? null
    },
  }
  // The aggregation deps are wide; this test needs exactly two members of them,
  // and a partial stub keeps the failure mode legible when the shape moves.
  return {
    ctx: { logger },
    capabilityRegistry: registry,
  } as unknown as Parameters<typeof getDeviceStatusAggregateBatch>[0]
}

describe('getDeviceStatusAggregateBatch', () => {
  it('returns one entry per device, keyed by id as a string', async () => {
    // A JSON object cannot key by number; asserting the string form here is
    // what stops a numeric-keyed record that only works in-process.
    const deps = makeDeps({
      battery: { getStatus: async ({ deviceId }) => ({ percentage: deviceId }) },
    })
    const out = await getDeviceStatusAggregateBatch(deps, {
      deviceIds: [101, 102],
      caps: ['battery'],
    })
    expect(Object.keys(out).sort()).toEqual(['101', '102'])
    expect(out['101']).toEqual({ battery: { percentage: 101 } })
    expect(out['102']).toEqual({ battery: { percentage: 102 } })
  })

  it('one throwing provider costs that cap, not the other devices', async () => {
    const deps = makeDeps({
      battery: {
        getStatus: async ({ deviceId }) => {
          if (deviceId === 101) throw new Error('provider down')
          return { percentage: 42 }
        },
      },
    })
    const out = await getDeviceStatusAggregateBatch(deps, {
      deviceIds: [101, 102],
      caps: ['battery'],
    })
    expect(out['101']).toEqual({ battery: null })
    expect(out['102']).toEqual({ battery: { percentage: 42 } })
  })

  it('an invalid status is dropped to null rather than passed through', async () => {
    const deps = makeDeps({
      battery: { getStatus: async () => ({ percentage: 'quite full' }) },
    })
    const out = await getDeviceStatusAggregateBatch(deps, { deviceIds: [1], caps: ['battery'] })
    expect(out['1']).toEqual({ battery: null })
  })

  it('de-duplicates ids so a repeated device is not asked twice', async () => {
    const seen: number[] = []
    const deps = makeDeps(
      { battery: { getStatus: async () => ({ percentage: 1 }) } },
      (_cap, deviceId) => seen.push(deviceId),
    )
    await getDeviceStatusAggregateBatch(deps, { deviceIds: [7, 7, 7], caps: ['battery'] })
    expect(seen).toEqual([7])
  })

  it('an empty list is an empty result, not a full sweep', async () => {
    const deps = makeDeps({ battery: { getStatus: async () => ({ percentage: 1 }) } })
    expect(await getDeviceStatusAggregateBatch(deps, { deviceIds: [] })).toEqual({})
  })
})

/**
 * A HANGING provider — the case the specs above do not reach, and the one that
 * actually happened.
 *
 * Every assertion above uses a provider that THROWS. A throw is the easy
 * failure: the `try/catch` already turns it into `null` and the batch finishes.
 * A cap whose provider never settles is a different animal — `Promise.all`
 * waits, the sequential window loop behind it waits, and the whole call never
 * returns. Nothing throws, so nothing is caught and nothing is logged.
 *
 * This is what a crash-looping agent node produces. The registry says the node
 * is online (it reconnected seconds ago), `classifyCapRoute` therefore ROUTES
 * the call instead of rejecting it `node-offline`, and the peer dies mid-call —
 * so the cap call sits for the transport's 60s `REMOTE_CALL_TIMEOUT_MS`. On
 * 2026-08-08 agent-a flapped every ~21s for 22 minutes and the viewer's
 * camera badges (one `getDeviceStatusAggregateBatch` for every card) never
 * resolved. A tRPC query that never settles is `isLoading` forever, so the app
 * sat on a skeleton with no error and no offline banner.
 *
 * The contract these specs pin: a cap that does not answer within the deadline
 * is `null` — the SAME value a throwing provider yields — the other caps and
 * the other devices are unaffected, and the batch returns.
 */
describe('getDeviceStatusAggregateBatch — a provider that never answers', () => {
  /** Never settles. The shape of a cap call routed at a node that just died. */
  const hangs = { getStatus: () => new Promise<unknown>(() => {}) }

  it('a hanging cap becomes null instead of stalling the call forever', async () => {
    const deps = makeDeps({ battery: hangs })
    const out = await getDeviceStatusAggregateBatch(
      deps,
      { deviceIds: [108], caps: ['battery'] },
      { deadlineMs: 20 },
    )
    expect(out['108']).toEqual({ battery: null })
  })

  it('one hanging device does not cost the healthy devices their status', async () => {
    // 108 is on the dead node; 101 and 102 are on the hub and answer at once.
    const deps = makeDeps({
      battery: {
        getStatus: ({ deviceId }) =>
          deviceId === 108
            ? new Promise<unknown>(() => {})
            : Promise.resolve({ percentage: deviceId }),
      },
    })
    const out = await getDeviceStatusAggregateBatch(
      deps,
      { deviceIds: [101, 102, 108], caps: ['battery'] },
      { deadlineMs: 20 },
    )
    expect(out['101']).toEqual({ battery: { percentage: 101 } })
    expect(out['102']).toEqual({ battery: { percentage: 102 } })
    expect(out['108']).toEqual({ battery: null })
  })

  it('a hanging device in an EARLY window does not stall the later windows', async () => {
    // The windows are walked sequentially, so a device that never answers in
    // window 1 used to hold every later window behind it. With 25 ids and a
    // window of 10 that is three waves; the last one must still be answered.
    const ids = Array.from({ length: 25 }, (_, i) => 600 + i)
    const deps = makeDeps({
      battery: {
        getStatus: ({ deviceId }) =>
          deviceId === 601
            ? new Promise<unknown>(() => {})
            : Promise.resolve({ percentage: deviceId }),
      },
    })
    const started = Date.now()
    const out = await getDeviceStatusAggregateBatch(
      deps,
      { deviceIds: ids, caps: ['battery'] },
      {
        deadlineMs: 20,
      },
    )
    // Every id answered, and the ONE dead device cost one deadline per window
    // it appears in — not one per window overall.
    expect(Object.keys(out)).toHaveLength(25)
    expect(out['601']).toEqual({ battery: null })
    expect(out['624']).toEqual({ battery: { percentage: 624 } })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('the drop is DECLARED — a silent timeout reads as "never happened"', async () => {
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const deps = makeDeps({ battery: hangs })
    Reflect.set(deps.ctx, 'logger', logger)
    await getDeviceStatusAggregateBatch(
      deps,
      { deviceIds: [108], caps: ['battery'] },
      {
        deadlineMs: 20,
      },
    )
    const call = logger.warn.mock.calls.find((c) => String(c[0]).includes('deadline'))
    expect(call).toBeDefined()
    // Repo rule: every log line about a device carries the numeric id under
    // `tags.deviceId`. A per-camera fault that cannot be grouped per camera
    // cannot answer the only question ever asked of it.
    expect(call?.[1]).toMatchObject({ tags: { deviceId: 108 }, meta: { capName: 'battery' } })
  })
})
