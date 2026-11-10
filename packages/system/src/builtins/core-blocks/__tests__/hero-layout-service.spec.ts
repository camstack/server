import { DeviceType } from '@camstack/types'
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { HeroLayoutService, type HeroLayoutReader } from '../hero-layout-service.js'

interface Logged {
  readonly message: string
  readonly tags: unknown
}

function logger(into: Logged[]): IScopedLogger {
  const line = (message: string, ctx?: { tags?: unknown }): void => {
    into.push({ message, tags: ctx?.tags })
  }
  const self: IScopedLogger = {
    debug: line,
    info: line,
    warn: line,
    error: line,
    child: () => self,
    withTags: () => self,
  }
  return self
}

function service(reader: Partial<HeroLayoutReader>, logs: Logged[] = []): HeroLayoutService {
  return new HeroLayoutService({
    logger: logger(logs),
    now: () => 1_700_000_000_000,
    reader: {
      device: async () => ({
        type: DeviceType.Heater,
        role: null,
        name: 'Stove',
        online: true,
        features: [],
      }),
      caps: async () => ['switch'],
      slice: async () => ({ on: true, lastChangedAt: 1 }),
      remoteCommands: async () => 0,
      ...reader,
    },
  })
}

describe('hero-layout provider', () => {
  it('serves the fixed rows of a type', async () => {
    const { rows } = await service({}).getLayout({ deviceType: DeviceType.Heater })
    expect(rows).toEqual(['run-for', 'cycle'])
  })

  it('an unknown device answers null and says so on the record, tagged', async () => {
    const logs: Logged[] = []
    const model = await service({ device: async () => null }, logs).getHeroModel({ deviceId: 9 })
    expect(model).toBeNull()
    expect(logs).toEqual([expect.objectContaining({ tags: { deviceId: 9 } })])
  })

  it('builds the model from the bound caps and their slices', async () => {
    const model = await service({}).getHeroModel({ deviceId: 7 })
    expect(model?.state).toBe('on')
    expect(model?.ownPower?.source).toBe('switch')
  })

  it('a slice that cannot be read is not answered: the heater is unknown, never off', async () => {
    const logs: Logged[] = []
    const model = await service(
      { slice: async () => Promise.reject(new Error('boom')) },
      logs,
    ).getHeroModel({
      deviceId: 7,
    })
    expect(model?.state).toBe('unknown')
    expect(model?.ownPower?.on).toBeNull()
    expect(logs.every((l) => (l.tags as { deviceId: number }).deviceId === 7)).toBe(true)
    expect(logs.length).toBeGreaterThan(0)
  })

  it('the remote is offered to any type when it holds commands', async () => {
    const model = await service({ remoteCommands: async () => 3 }).getHeroModel({ deviceId: 7 })
    expect(model?.remote).toMatchObject({ commands: 3, open: { id: 'remote.open' } })
  })

  it('a remote that cannot be asked still shows its button, without a count', async () => {
    const model = await service({
      remoteCommands: async () => Promise.reject(new Error('x')),
    }).getHeroModel({
      deviceId: 7,
    })
    expect(model?.remote).toMatchObject({ commands: null, open: { id: 'remote.open' } })
  })

  it('a remote with no commands shows no button', async () => {
    const model = await service({ remoteCommands: async () => 0 }).getHeroModel({ deviceId: 7 })
    expect(model?.remote).toBeNull()
  })

  it('a caller that may not act is told what to hide', async () => {
    const reader = { slice: vi.fn(async () => ({ on: true, lastChangedAt: 1 })) }
    const model = await service(reader).getHeroModel({ deviceId: 7, canActuate: false })
    expect(model?.gated).toContain('own-power')
    const open = await service(reader).getHeroModel({ deviceId: 7 })
    expect(open?.gated).toEqual([])
  })
})

describe('hero-layout getRowModels', () => {
  it('answers a whole list in order, null for an unknown id, and reads each device once', async () => {
    const device = vi.fn(async (id: number) =>
      id === 99
        ? null
        : {
            type: DeviceType.Heater,
            role: null,
            name: `Dev ${id}`,
            online: true,
            features: [],
          },
    )
    const rows = await service({ device }).getRowModels({ deviceIds: [3, 99, 4] })
    expect(rows.map((r) => r?.deviceId ?? null)).toEqual([3, null, 4])
    expect(rows[0]).toMatchObject({ scene: { id: 'heater' }, name: 'Dev 3' })
    expect(rows[0]?.primary).toMatchObject({ kind: 'toggle', id: 'own-power' })
    expect(device).toHaveBeenCalledTimes(3)
  })

  it('a caller that may not act gets rows without an inline control', async () => {
    const [row] = await service({}).getRowModels({ deviceIds: [1], canActuate: false })
    expect(row?.primary).toBeNull()
  })

  it('keeps the order across chunks of 16 and reads a repeated id once', async () => {
    const device = vi.fn(async (id: number) => ({
      type: DeviceType.Heater,
      role: null,
      name: `Dev ${id}`,
      online: true,
      features: [],
    }))
    const ids = [...Array.from({ length: 40 }, (_, i) => 100 + i), 105, 100]
    const rows = await service({ device }).getRowModels({ deviceIds: ids })
    expect(rows.map((r) => r?.deviceId)).toEqual(ids)
    expect(device).toHaveBeenCalledTimes(40)
  })

  it('a device that throws is a null row with a tagged warning, the others still answer', async () => {
    const logs: Logged[] = []
    const device = async (id: number) => {
      if (id === 2) throw new Error('registry down')
      return { type: DeviceType.Heater, role: null, name: 'D', online: true, features: [] }
    }
    const rows = await service({ device }, logs).getRowModels({ deviceIds: [1, 2, 3] })
    expect(rows.map((r) => r?.deviceId ?? null)).toEqual([1, null, 3])
    expect(logs).toEqual([expect.objectContaining({ tags: { deviceId: 2 } })])
    const caps = await service(
      { caps: async () => Promise.reject(new Error('x')) },
      logs,
    ).getRowModels({
      deviceIds: [5],
    })
    expect(caps).toEqual([null])
  })

  it('an empty list is an empty answer', async () => {
    expect(await service({}).getRowModels({ deviceIds: [] })).toEqual([])
  })
})
