/**
 * The device-history retention pass sweeps the transition ledger as its fifth
 * step (D1022): the same job, the same policy object, `transitionDays` among
 * the four tiers - no second mechanism.
 */
import { createRecordsAccess, DeviceType, type DeviceTransition } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { makeRecordsWorld } from '../../../sqlite-storage/__tests__/support/records-world.js'
import { type Harness, makeHarness } from '../../__tests__/support/harness.js'
import { silentLogger } from '../../__tests__/support/real-door.js'
import { DAY_MS } from '../../time/bucket-time.js'
import { KERNEL_CALLER, TransitionsService } from '../../transitions/transitions-service.js'
import { DEFAULT_RETENTION, transitionCutoff } from '../retention.js'

let h: Harness
afterEach(async () => {
  await h?.close()
})

function row(id: string, at: number): DeviceTransition {
  return {
    id,
    deviceId: 1,
    at,
    capName: 'switch',
    field: 'on',
    from: false,
    to: true,
    outcome: 'device',
    actor: { kind: 'device' },
  }
}

async function rig() {
  h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
  const world = makeRecordsWorld()
  await world.provider.init()
  const service = new TransitionsService({
    records: createRecordsAccess({
      owner: 'device-history',
      transport: world.transportFor('device-history'),
      secrets: null,
    }),
    logger: silentLogger(),
    clock: () => h.now(),
    yieldNow: async () => {},
  })
  await service.open()
  h.runtime.retentionJob.attachTransitions(service)
  return service
}

const ids = async (service: TransitionsService): Promise<readonly string[]> =>
  (await service.list({ deviceId: 1, limit: 50 })).transitions.map((t) => t.id)

describe('transition retention', () => {
  it('defaults to a year and cuts at now minus transitionDays', () => {
    expect(DEFAULT_RETENTION.transitionDays).toBe(365)
    expect(transitionCutoff({ ...DEFAULT_RETENTION, transitionDays: 10 }, 100 * DAY_MS)).toBe(
      90 * DAY_MS,
    )
  })

  it('deletes older rows, keeps the row at the cutoff, and honours the configured days', async () => {
    const service = await rig()
    const now = h.now()
    const policy = { ...DEFAULT_RETENTION, transitionDays: 30 }
    const cutoff = transitionCutoff(policy, now)
    await service.record(KERNEL_CALLER, [
      row('1:old:0', cutoff - 5 * DAY_MS),
      row('1:just-before:0', cutoff - 1),
      row('1:at:0', cutoff),
      row('1:new:0', now),
    ])
    await h.runtime.retentionJob.run(policy, now)
    expect(await ids(service)).toEqual(['1:new:0', '1:at:0'])
  })

  it('keeps the default year when the policy is the default', async () => {
    const service = await rig()
    const now = h.now()
    await service.record(KERNEL_CALLER, [
      row('1:ten-months:0', now - 300 * DAY_MS),
      row('1:two-years:0', now - 730 * DAY_MS),
    ])
    await h.runtime.retentionJob.run(DEFAULT_RETENTION, now)
    expect(await ids(service)).toEqual(['1:ten-months:0'])
  })

  it('sweeps again only once the cutoff has moved on by a day', async () => {
    const service = await rig()
    const now = h.now()
    await h.runtime.retentionJob.run(DEFAULT_RETENTION, now)
    const cutoff = transitionCutoff(DEFAULT_RETENTION, now)
    await service.record(KERNEL_CALLER, [row('1:straggler:0', cutoff - 1000)])
    h.advance(60 * 60_000)
    await h.runtime.retentionJob.run(DEFAULT_RETENTION, h.now())
    expect(await ids(service)).toEqual(['1:straggler:0'])
    h.advance(DAY_MS)
    await h.runtime.retentionJob.run(DEFAULT_RETENTION, h.now())
    expect(await ids(service)).toEqual([])
  })
})
