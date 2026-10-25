/**
 * A SYSTEM-scoped COLLECTION cap has no per-device status, so the per-device
 * status aggregate never asks it (D634, fix round 3, review R2-H1).
 *
 * `getProviderForDevice` answers a collection cap with no native provider by
 * returning the FIRST registered provider — so for `device-export` any device
 * id reached whichever export addon registered first, and its `getStatus()`
 * returned that addon's `setup` block: the HomeKit `X-HM://` pairing URI, the
 * Alexa ingress token. `device-export`, `broker` and `mqtt-broker` are the
 * status caps of that shape, and none of their answers is ABOUT the device —
 * a cluster-wide export status stamped onto camera 101 is meaningless, and it
 * reached every viewer through `getDeviceStatusAggregate(Batch)` whether the
 * caps were omitted (the default list carries all status caps) or named.
 *
 * Device-scoped caps and system SINGLETONS with a real per-device status
 * (`recording-archive`, one of the viewer's badge caps) are unaffected.
 */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { getDeviceStatusAggregate, getDeviceStatusAggregateBatch } from '../device-aggregation.js'

const EXPORT_SCHEMA = z.object({
  linkState: z.string(),
  exposedDeviceCount: z.number(),
  setup: z.object({ qr: z.string().optional() }).optional(),
})
const BATTERY_SCHEMA = z.object({ percentage: z.number() })
const ARCHIVE_SCHEMA = z.object({ deviceId: z.number(), enabled: z.boolean() })

const DEFINITIONS: Readonly<Record<string, unknown>> = {
  'device-export': { scope: 'system', mode: 'collection', status: { schema: EXPORT_SCHEMA } },
  battery: { scope: 'device', mode: 'singleton', status: { schema: BATTERY_SCHEMA } },
  'recording-archive': { scope: 'system', mode: 'singleton', status: { schema: ARCHIVE_SCHEMA } },
}

function makeDeps(asked: string[]): Parameters<typeof getDeviceStatusAggregate>[0] {
  const providers: Readonly<
    Record<string, { getStatus: (i: { deviceId: number }) => Promise<unknown> }>
  > = {
    'device-export': {
      getStatus: async () => {
        asked.push('device-export')
        return { linkState: 'linked', exposedDeviceCount: 3, setup: { qr: 'X-HM://HAPSECRET' } }
      },
    },
    battery: { getStatus: async () => ({ percentage: 80 }) },
    'recording-archive': {
      getStatus: async ({ deviceId }) => ({ deviceId, enabled: true }),
    },
  }
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const registry = {
    getDefinition: (name: string) => DEFINITIONS[name] ?? null,
    getProviderForDevice: (capName: string) => providers[capName] ?? null,
  }
  // Documented test boundary — the same partial-deps stub as
  // `status-aggregate-batch.spec.ts`: the aggregation deps are wide and this
  // exercises exactly two members of them.
  return {
    ctx: { logger },
    capabilityRegistry: registry,
  } as unknown as Parameters<typeof getDeviceStatusAggregate>[0]
}

describe('per-device status never asks a system collection cap', () => {
  it('single, caps omitted: device-export is null and its provider is never called', async () => {
    const asked: string[] = []
    const out = await getDeviceStatusAggregate(makeDeps(asked), { deviceId: 101 })
    expect(out['device-export']).toBeNull()
    expect(asked).toEqual([])
    expect(JSON.stringify(out)).not.toContain('HAPSECRET')
    // Real per-device statuses still answer.
    expect(out['battery']).toEqual({ percentage: 80 })
  })

  it('single, caps named explicitly: still null', async () => {
    const asked: string[] = []
    const out = await getDeviceStatusAggregate(makeDeps(asked), {
      deviceId: 101,
      caps: ['device-export'],
    })
    expect(out).toEqual({ 'device-export': null })
    expect(asked).toEqual([])
  })

  it('batch, caps omitted and named: no device carries the export setup', async () => {
    const asked: string[] = []
    const omitted = await getDeviceStatusAggregateBatch(makeDeps(asked), { deviceIds: [101, 102] })
    const named = await getDeviceStatusAggregateBatch(makeDeps(asked), {
      deviceIds: [101, 102],
      caps: ['device-export'],
    })
    for (const out of [omitted, named]) {
      expect(out['101']?.['device-export']).toBeNull()
      expect(out['102']?.['device-export']).toBeNull()
      expect(JSON.stringify(out)).not.toContain('HAPSECRET')
    }
    expect(asked).toEqual([])
  })

  it('the viewer badge caps keep working, recording-archive (a system SINGLETON) included', async () => {
    const out = await getDeviceStatusAggregateBatch(makeDeps([]), {
      deviceIds: [101],
      caps: ['battery', 'recording-archive', 'network-link'],
    })
    expect(out['101']).toEqual({
      battery: { percentage: 80 },
      'recording-archive': { deviceId: 101, enabled: true },
      'network-link': null,
    })
  })
})
