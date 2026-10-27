import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildEnpalAdoptionProvider } from '../enpal-adoption-provider.js'
import { createSnapshot, type EnpalReading } from '../enpal-snapshot.js'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

function snapshotOf(...keys: string[]) {
  const readings: EnpalReading[] = keys.map((key) => ({
    key,
    value: 1,
    unit: undefined,
    measurement: undefined,
  }))
  return createSnapshot('influxdb', readings, 1)
}

function harness(keys: string[]) {
  const adoptCalls: Array<{
    equipment: string
    specIds: readonly string[]
    name: string
  }> = []
  const removed: number[] = []
  const provider = buildEnpalAdoptionProvider({
    getSnapshot: (id) => (id === 'int-1' ? snapshotOf(...keys) : null),
    hasIntegration: (id) => id === 'int-1',
    listIntegrations: () => ['int-1'],
    listAdopted: async () => [],
    adoptDevice: async (input) => {
      adoptCalls.push({
        equipment: input.equipment,
        specIds: input.specIds,
        name: input.name,
      })
      return {
        deviceId: 10 + adoptCalls.length,
        accessoryDeviceIds: input.specIds.map((_, i) => 100 + i),
      }
    },
    removeDevice: async (id) => {
      removed.push(id)
    },
    findDeviceConfig: async () => null,
    logger: quiet,
  })
  return { provider, adoptCalls, removed }
}

describe('Enpal adoption', () => {
  it('lists the containers the box reported', async () => {
    const h = harness(['Power.Consumption.Total', 'Heatpump.Power.Consumption.Total'])
    const page = await h.provider.listCandidates({
      integrationId: 'int-1',
      page: 1,
      pageSize: 50,
    })
    expect(page.candidates.map((c) => c.childNativeId)).toEqual(['house', 'heatpump'])
  })

  it('adopting a container adopts its reported children and returns their ids', async () => {
    const h = harness(['Energy.Battery.Charge.Level', 'Battery.SOH', 'Temperature.Housing.Inside'])
    const out = await h.provider.adopt({
      integrationId: 'int-1',
      childNativeIds: ['battery'],
    })
    expect(h.adoptCalls).toEqual([
      {
        equipment: 'battery',
        specIds: ['battery', 'battery-health'],
        name: 'Battery',
      },
    ])
    expect(out.adopted).toEqual([
      {
        childNativeId: 'battery',
        parentDeviceId: 11,
        accessoryDeviceIds: [100, 101],
      },
    ])
  })

  it('honours the operator name override', async () => {
    const h = harness(['Power.Consumption.Total'])
    await h.provider.adopt({
      integrationId: 'int-1',
      childNativeIds: ['house'],
      perCandidate: { house: { name: 'Villa' } },
    })
    expect(h.adoptCalls[0]?.name).toBe('Villa')
  })

  it('refuses an equipment the box did not report', async () => {
    const h = harness(['Power.Consumption.Total'])
    await expect(
      h.provider.adopt({
        integrationId: 'int-1',
        childNativeIds: ['heatpump'],
      }),
    ).rejects.toThrow(/failed/)
    expect(h.adoptCalls).toEqual([])
  })

  it('release removes the container device', async () => {
    const h = harness(['Power.Consumption.Total'])
    await h.provider.release({ integrationId: 'int-1', camDeviceId: 7 })
    expect(h.removed).toEqual([7])
  })
})
