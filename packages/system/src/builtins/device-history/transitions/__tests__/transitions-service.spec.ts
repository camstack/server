/**
 * The transition ledger over the REAL records engine (two in-memory SQLite
 * files, the real provider). Only the hub and time are stand-ins.
 */
import { createRecordsAccess, type DeviceTransition } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeRecordsWorld } from '../../../sqlite-storage/__tests__/support/records-world.js'
import { type CapturedLog, recordingLogger } from '../../__tests__/support/real-door.js'
import { DAY_MS } from '../../time/bucket-time.js'
import { KERNEL_CALLER, TransitionsService } from '../transitions-service.js'

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0)

function transition(over: Partial<DeviceTransition> & { id: string }): DeviceTransition {
  return {
    deviceId: 1,
    at: T0,
    capName: 'switch',
    field: 'on',
    from: false,
    to: true,
    outcome: 'confirmed',
    actor: { kind: 'user', userId: 'u1', username: 'ada', credential: 'session' },
    ...over,
  }
}

async function makeRig() {
  const world = makeRecordsWorld()
  await world.provider.init()
  const logs: CapturedLog[] = []
  const records = createRecordsAccess({
    owner: 'device-history',
    transport: world.transportFor('device-history'),
    secrets: null,
  })
  let yields = 0
  const service = new TransitionsService({
    records,
    logger: recordingLogger(logs),
    clock: () => T0,
    yieldNow: async () => {
      yields += 1
    },
  })
  await service.open()
  return { service, logs, yields: () => yields }
}

describe('record', () => {
  it('writes a batch from the kernel and reads it back', async () => {
    const { service } = await makeRig()
    const result = await service.record(KERNEL_CALLER, [
      transition({ id: '1:1:0', at: T0 }),
      transition({ id: '1:2:0', at: T0 + 1000, to: false, from: true }),
    ])
    expect(result).toEqual({ written: 2, refused: [] })
    const page = await service.list({ deviceId: 1, limit: 10 })
    expect(page.transitions.map((t) => t.id)).toEqual(['1:2:0', '1:1:0'])
    expect((await service.status()).rows).toBe(2)
  })

  it('refuses a stamped addon and an unstamped caller as not-kernel, and counts it', async () => {
    const { service, logs } = await makeRig()
    const rows = [transition({ id: '1:1:0' })]
    for (const caller of ['core-blocks', null]) {
      const result = await service.record(caller, rows)
      expect(result).toEqual({ written: 0, refused: [{ id: '1:1:0', reason: 'not-kernel' }] })
    }
    expect((await service.list({ deviceId: 1, limit: 10 })).transitions).toEqual([])
    expect((await service.status()).refused).toEqual({ 'not-kernel': 2 })
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('not-kernel'))).toBe(true)
  })

  it('is idempotent on the id', async () => {
    const { service } = await makeRig()
    const row = transition({ id: '1:1:0' })
    await service.record(KERNEL_CALLER, [row])
    await service.record(KERNEL_CALLER, [row])
    expect((await service.status()).rows).toBe(1)
  })

  it('refuses a row the engine rejects as invalid and still writes the others', async () => {
    const { service, logs } = await makeRig()
    const huge = transition({
      id: '1:9:0',
      command: {
        commandId: 'c',
        method: 'setState',
        args: { blob: 'x'.repeat(200_000) },
        requestedAt: T0,
        matchedAfterMs: 1,
      },
    })
    const result = await service.record(KERNEL_CALLER, [transition({ id: '1:1:0' }), huge])
    expect(result.written).toBe(1)
    expect(result.refused).toEqual([{ id: '1:9:0', reason: 'invalid' }])
    expect(logs.some((l) => l.tags['deviceId'] === 1)).toBe(true)
  })
})

describe('reads', () => {
  async function seeded() {
    const rig = await makeRig()
    await rig.service.record(KERNEL_CALLER, [
      transition({ id: '1:1:0', at: T0 + 1 }),
      transition({
        id: '1:2:0',
        at: T0 + 2,
        capName: 'brightness',
        field: 'level',
        from: 1,
        to: 2,
      }),
      transition({ id: '1:3:0', at: T0 + 3, outcome: 'device', actor: { kind: 'device' } }),
      transition({
        id: '1:4:0',
        at: T0 + 4,
        outcome: 'unconfirmed',
        actor: { kind: 'addon', addonId: 'addon-export-alexa' },
      }),
      transition({ id: '2:1:0', deviceId: 2, at: T0 + 5, outcome: 'failed' }),
    ])
    return rig
  }

  it('filters a device by cap, by actor kind and by outcome, one at a time', async () => {
    const { service } = await seeded()
    const ids = async (input: Parameters<TransitionsService['list']>[0]) =>
      (await service.list(input)).transitions.map((t) => t.id)
    expect(await ids({ deviceId: 1, limit: 50 })).toEqual(['1:4:0', '1:3:0', '1:2:0', '1:1:0'])
    expect(await ids({ deviceId: 1, capName: 'brightness', limit: 50 })).toEqual(['1:2:0'])
    expect(await ids({ deviceId: 1, actorKind: 'device', limit: 50 })).toEqual(['1:3:0'])
    expect(await ids({ deviceId: 1, outcome: 'unconfirmed', limit: 50 })).toEqual(['1:4:0'])
  })

  it('narrows to a time window', async () => {
    const { service } = await seeded()
    const page = await service.list({ deviceId: 1, atFrom: T0 + 2, atTo: T0 + 4, limit: 50 })
    expect(page.transitions.map((t) => t.id)).toEqual(['1:3:0', '1:2:0'])
    const byCap = await service.list({
      deviceId: 1,
      capName: 'switch',
      atFrom: T0 + 2,
      limit: 50,
    })
    expect(byCap.transitions.map((t) => t.id)).toEqual(['1:4:0', '1:3:0'])
  })

  it('refuses a call that names two filters', async () => {
    const { service } = await seeded()
    await expect(
      service.list({ deviceId: 1, capName: 'switch', outcome: 'device', limit: 10 }),
    ).rejects.toThrow(/one of/)
  })

  it('pages with a cursor and answers an empty page for a device with none', async () => {
    const { service } = await seeded()
    const first = await service.list({ deviceId: 1, limit: 3 })
    expect(first.transitions.map((t) => t.id)).toEqual(['1:4:0', '1:3:0', '1:2:0'])
    expect(first.nextCursor).not.toBeNull()
    const second = await service.list({ deviceId: 1, limit: 3, cursor: first.nextCursor ?? '' })
    expect(second.transitions.map((t) => t.id)).toEqual(['1:1:0'])
    expect(second.nextCursor).toBeNull()
    expect(await service.list({ deviceId: 77, limit: 3 })).toEqual({
      transitions: [],
      nextCursor: null,
    })
  })

  it('gets one transition only for its own device', async () => {
    const { service } = await seeded()
    expect((await service.get({ deviceId: 1, id: '1:2:0' }))?.capName).toBe('brightness')
    expect(await service.get({ deviceId: 2, id: '1:2:0' })).toBeNull()
  })

  it('lists the fleet newest first, narrowed by actor kind or outcome', async () => {
    const { service } = await seeded()
    const ids = async (input: Parameters<TransitionsService['listRecent']>[0]) =>
      (await service.listRecent(input)).transitions.map((t) => t.id)
    expect(await ids({ limit: 50 })).toEqual(['2:1:0', '1:4:0', '1:3:0', '1:2:0', '1:1:0'])
    expect(await ids({ actorKind: 'addon', limit: 50 })).toEqual(['1:4:0'])
    expect(await ids({ outcome: 'failed', limit: 50 })).toEqual(['2:1:0'])
  })
})

describe('retention and removal', () => {
  it('keeps the row at the cutoff, deletes older ones in day slices, yielding between them', async () => {
    const { service, yields } = await makeRig()
    const cutoff = T0
    await service.record(KERNEL_CALLER, [
      transition({ id: '1:a:0', at: cutoff - 3 * DAY_MS - 5 }),
      transition({ id: '1:b:0', at: cutoff - 2 * DAY_MS }),
      transition({ id: '1:c:0', at: cutoff - 1 }),
      transition({ id: '1:d:0', at: cutoff }),
      transition({ id: '1:e:0', at: cutoff + 1 }),
    ])
    const deleted = await service.sweep(cutoff)
    expect(deleted).toBe(3)
    const left = await service.list({ deviceId: 1, limit: 10 })
    expect(left.transitions.map((t) => t.id)).toEqual(['1:e:0', '1:d:0'])
    expect(yields()).toBeGreaterThanOrEqual(3)
  })

  it('sweeps nothing from an empty ledger', async () => {
    const { service, yields } = await makeRig()
    expect(await service.sweep(T0)).toBe(0)
    expect(yields()).toBe(0)
  })

  it('deletes the rows of a removed device and counts rows per device', async () => {
    const { service } = await makeRig()
    await service.record(KERNEL_CALLER, [
      transition({ id: '1:1:0' }),
      transition({ id: '1:2:0', at: T0 + 1 }),
      transition({ id: '2:1:0', deviceId: 2 }),
    ])
    expect(await service.countByDevice()).toEqual(
      expect.arrayContaining([
        { deviceId: 1, count: 2 },
        { deviceId: 2, count: 1 },
      ]),
    )
    expect(await service.removeDevice(1)).toBe(2)
    expect((await service.list({ deviceId: 1, limit: 10 })).transitions).toEqual([])
    expect((await service.list({ deviceId: 2, limit: 10 })).transitions).toHaveLength(1)
  })
})
