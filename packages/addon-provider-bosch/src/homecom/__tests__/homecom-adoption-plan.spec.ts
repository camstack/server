import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { buildHomeComAdoptionProvider } from '../homecom-adoption-provider.js'
import { planHomeComAdoption } from '../homecom-adoption-plan.js'
import type { HomeComDiscoverableDevice } from '../homecom-gateway.js'

const HEAT_PUMP: HomeComDiscoverableDevice = {
  nativeId: 'hp:0',
  name: 'Heat pump',
  kind: 'heat-pump',
  children: [
    { nativeId: 'hc:hc1', name: 'Heating circuit 1', kind: 'heating-circuit', circuitId: 'hc1' },
    { nativeId: 'dhw:0', name: 'Hot water', kind: 'dhw' },
  ],
}

const CIRCUIT: HomeComDiscoverableDevice = {
  nativeId: 'hc:hc1',
  name: 'Heating circuit 1',
  kind: 'heating-circuit',
  circuitId: 'hc1',
}

function logger(): IScopedLogger {
  const log: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => log,
    withTags: () => log,
  }
  return log
}

describe('planHomeComAdoption', () => {
  it('creates the heat pump and one child per circuit and hot water', () => {
    const plan = planHomeComAdoption(HEAT_PUMP, 'int-1', [])
    expect(plan.stayedTopLevel).toEqual([])
    expect(plan.create.map((row) => [row.nativeId, row.parentNativeId, row.name])).toEqual([
      ['hp:0', null, 'Heat pump'],
      ['hc:hc1', 'hp:0', 'Heating circuit 1'],
      ['dhw:0', 'hp:0', 'Hot water'],
    ])
  })

  it('leaves an already adopted top-level circuit where it is', () => {
    const plan = planHomeComAdoption(HEAT_PUMP, 'int-1', [
      { id: 41, stableId: 'homecom:int-1:hc:hc1', parentDeviceId: null },
    ])
    expect(plan.create.map((row) => row.nativeId)).toEqual(['hp:0', 'dhw:0'])
    expect(plan.stayedTopLevel).toEqual([{ nativeId: 'hc:hc1', deviceId: 41 }])
  })

  it('does not duplicate a circuit that already has a parent', () => {
    const plan = planHomeComAdoption(HEAT_PUMP, 'int-1', [
      { id: 41, stableId: 'homecom:int-1:hc:hc1', parentDeviceId: 9 },
    ])
    expect(plan.create.map((row) => row.nativeId)).toEqual(['hp:0', 'dhw:0'])
    expect(plan.stayedTopLevel).toEqual([])
    expect(plan.alreadyPresent).toEqual([{ nativeId: 'hc:hc1', deviceId: 41 }])
  })

  it('adopts a boiler circuit on its own', () => {
    const plan = planHomeComAdoption(CIRCUIT, 'int-1', [])
    expect(plan.create).toEqual([
      {
        nativeId: 'hc:hc1',
        name: 'Heating circuit 1',
        kind: 'heating-circuit',
        circuitId: 'hc1',
        parentNativeId: null,
      },
    ])
  })
})

describe('HomeCom heat-pump adopt', () => {
  it('creates children under the heat pump and logs a top-level circuit once', async () => {
    const log = logger()
    const calls: { readonly nativeId: string; readonly parentDeviceId: number | null }[] = []
    let nextId = 10
    const provider = buildHomeComAdoptionProvider({
      registry: {
        has: () => true,
        discoverables: () => [HEAT_PUMP],
      },
      hasIntegration: () => true,
      listIntegrations: () => ['int-1'],
      listAdopted: async () => [
        {
          id: 41,
          stableId: 'homecom:int-1:hc:hc1',
          parentDeviceId: null,
          config: { system: 'homecom', brokerId: 'int-1', nativeId: 'hc:hc1' },
        },
      ],
      adoptDevice: async (input) => {
        calls.push({ nativeId: input.nativeId, parentDeviceId: input.parentDeviceId })
        nextId += 1
        return { deviceId: input.nativeId === 'hp:0' ? 10 : nextId }
      },
      removeDevice: async () => undefined,
      findDeviceConfig: async () => null,
      logger: log,
    })
    const first = await provider.adopt({ integrationId: 'int-1', childNativeIds: ['hp:0'] })
    const second = await provider.adopt({ integrationId: 'int-1', childNativeIds: ['hp:0'] })
    expect(first.adopted[0]?.parentDeviceId).toBe(10)
    expect(first.adopted[0]?.accessoryDeviceIds).toEqual([12])
    expect(calls.filter((call) => call.nativeId === 'hc:hc1')).toEqual([])
    expect(
      calls.filter((call) => call.nativeId === 'dhw:0').map((call) => call.parentDeviceId),
    ).toEqual([10, 10])
    expect(second.adopted).toHaveLength(1)
    const stayed = vi
      .mocked(log.info)
      .mock.calls.filter((call) => String(call[0]).includes('stayed top-level'))
    expect(stayed).toHaveLength(1)
    expect(stayed[0]?.[1]).toEqual({ tags: { deviceId: 41 } })
  })
})
