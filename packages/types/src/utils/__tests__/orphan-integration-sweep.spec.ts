import { describe, expect, it } from 'vitest'
import type { IScopedLogger } from '../../interfaces/logging.js'
import { collectOwnerIntegrationIds, OrphanIntegrationSweep } from '../orphan-integration-sweep.js'

const logs: string[] = []
const logger: IScopedLogger = {
  debug: () => undefined,
  info: (m) => void logs.push(`info:${m}`),
  warn: (m) => void logs.push(`warn:${m}`),
  error: () => undefined,
  child: () => logger,
  withTags: () => logger,
}

function setup() {
  let t = 1_000
  const removedIds: string[] = []
  const sweep = new OrphanIntegrationSweep({ logger, minIntervalMs: 60_000, now: () => t })
  const run = (listedIds: readonly string[] | null, ownerIds: readonly string[] = ['gone']) =>
    sweep.sweep({
      ownerIds,
      listedIds,
      removeDevices: async (id) => {
        removedIds.push(id)
        return 2
      },
    })
  return { run, removedIds, advance: (ms: number) => void (t += ms) }
}

describe('OrphanIntegrationSweep', () => {
  it('a failed read changes nothing and clears nothing', async () => {
    const s = setup()
    await s.run(['other'])
    s.advance(61_000)
    await s.run(null)
    await s.run(null)
    expect(s.removedIds).toEqual([])
    const again = await s.run(['other'])
    expect(again.removed).toEqual(['gone'])
  })

  it('one missing read is only a suspect', async () => {
    const s = setup()
    const r = await s.run(['other'])
    expect(r.newSuspects).toBe(1)
    expect(s.removedIds).toEqual([])
  })

  it('a second answered read after the interval removes', async () => {
    const s = setup()
    await s.run([])
    s.advance(60_000)
    const r = await s.run([])
    expect(r.removed).toEqual(['gone'])
    expect(s.removedIds).toEqual(['gone'])
  })

  it('a second read that is too close does not remove', async () => {
    const s = setup()
    await s.run([])
    s.advance(5_000)
    await s.run([])
    expect(s.removedIds).toEqual([])
  })

  it('reappearing clears the suspect, so the clock restarts', async () => {
    const s = setup()
    await s.run([])
    s.advance(30_000)
    await s.run(['gone'])
    s.advance(40_000)
    await s.run([])
    expect(s.removedIds).toEqual([])
  })

  it('a failed removal keeps the suspect for a retry', async () => {
    let t = 0
    const sweep = new OrphanIntegrationSweep({ logger, minIntervalMs: 10, now: () => t })
    const input = (fail: boolean) => ({
      ownerIds: ['gone'],
      listedIds: [] as string[],
      removeDevices: async () => {
        if (fail) throw new Error('boom')
        return 1
      },
    })
    await sweep.sweep(input(false))
    t = 20
    expect((await sweep.sweep(input(true))).removed).toEqual([])
    expect((await sweep.sweep(input(false))).removed).toEqual(['gone'])
  })
})

describe('collectOwnerIntegrationIds', () => {
  it('names the integrations of top-level devices only', async () => {
    const ids = await collectOwnerIntegrationIds({
      addonId: 'a',
      reg: {
        getAllForAddon: () => [
          { id: 1, parentDeviceId: null },
          { id: 2, parentDeviceId: 1 },
          { id: 3, parentDeviceId: null },
        ],
      },
      devices: {
        loadConfig: async (id) =>
          id === 3 ? Promise.reject(new Error('x')) : { system: 's', integrationId: `i${id}` },
      },
      ownerOf: (c) =>
        c['system'] === 's' && typeof c['integrationId'] === 'string' ? c['integrationId'] : null,
    })
    expect(ids).toEqual(['i1'])
  })
})
