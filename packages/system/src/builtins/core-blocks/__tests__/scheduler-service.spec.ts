import { type ActionStep, type SchedulerInput, SchedulerError } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { RunsLedger } from '../runs-ledger.js'
import { SchedulersService } from '../scheduler/scheduler-service.js'
import { ALL_DAYS, at, harness, ROME } from './scheduler-support.js'
import { capUnitResolver, ALL_CAPABILITY_DEFINITIONS, createRecordsAccess } from '@camstack/types'
import { makeRecordsWorld } from '../../sqlite-storage/__tests__/support/records-world.js'
import { coreBlocksRecordKinds } from '../record-kinds.js'

const MIDNIGHT = at('2026-03-09T23:00:00Z')

function turn(on: boolean, id: number): ActionStep {
  return {
    kind: 'cap',
    actionId: on ? 'switch.on' : 'switch.off',
    target: { kind: 'devices', ids: [id] },
    cap: 'switch',
    method: 'setState',
    args: { on },
  }
}

function holdScheduler(on: boolean, priority: number): SchedulerInput {
  return {
    name: on ? 'on' : 'off',
    enabled: true,
    priority,
    maxLateMs: 600_000,
    profiles: [
      {
        id: 'p',
        name: 'P',
        enabled: true,
        days: [...ALL_DAYS],
        points: [
          {
            id: 'h',
            at: { kind: 'clock', hh: 8, mm: 0 },
            mode: 'hold',
            steps: [turn(on, 1)],
          },
          {
            id: 'r',
            at: { kind: 'clock', hh: 10, mm: 0 },
            mode: 'release',
            steps: [],
          },
        ],
      },
    ],
  }
}

async function service() {
  const w = await harness({ start: MIDNIGHT, devices: [{ id: 1 }] })
  const world = makeRecordsWorld()
  await world.provider.init()
  const records = createRecordsAccess({
    owner: 'core-blocks',
    transport: world.transportFor('core-blocks'),
    secrets: null,
  })
  await records.declare(coreBlocksRecordKinds)
  const ledger = new RunsLedger({
    runs: records.kind(coreBlocksRecordKinds.runs),
    logger: w.logs.logger,
    now: () => w.clock.now(),
  })
  const svc = new SchedulersService({
    store: w.store,
    engine: w.engine,
    ledger,
    host: { readSite: async () => ROME },
    targets: w.targets,
    units: capUnitResolver(ALL_CAPABILITY_DEFINITIONS),
    logger: w.logs.logger,
    now: () => w.clock.now(),
  })
  return { w, svc }
}

describe('schedulers service', () => {
  it('refuses a hold without an effect with a typed reason, and stores nothing', async () => {
    const { w, svc } = await service()
    const step: ActionStep = {
      kind: 'cap',
      target: { kind: 'devices', ids: [1] },
      cap: 'switch',
      method: 'toggle',
      args: {},
    }
    const input: SchedulerInput = {
      ...holdScheduler(true, 0),
      profiles: [
        {
          id: 'p',
          name: 'P',
          enabled: true,
          days: [...ALL_DAYS],
          points: [
            {
              id: 'h',
              at: { kind: 'clock', hh: 8, mm: 0 },
              mode: 'hold',
              steps: [step],
            },
          ],
        },
      ],
    }
    await expect(svc.create({ scheduler: input })).rejects.toBeInstanceOf(SchedulerError)
    expect(await w.store.list()).toHaveLength(0)
  })

  it('previews the resolved day timeline', async () => {
    const { svc } = await service()
    const { scheduler } = await svc.create({
      scheduler: holdScheduler(true, 0),
    })
    const preview = await svc.preview({
      schedulerId: scheduler.id,
      date: '2026-03-10',
    })
    expect(preview.profileId).toBe('p')
    expect(preview.points.map((p) => [p.pointId, p.at])).toEqual([
      ['h', at('2026-03-10T07:00:00Z')],
      ['r', at('2026-03-10T09:00:00Z')],
    ])
    expect(preview.points[0]?.until).toBe(at('2026-03-10T09:00:00Z'))
  })

  it('reports an overlapping hold on the same device with a different effect, with priorities', async () => {
    const { svc } = await service()
    await svc.create({ scheduler: holdScheduler(false, 5) })
    const { conflicts } = await svc.conflicts({
      scheduler: holdScheduler(true, 1),
    })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      deviceId: 1,
      cap: 'switch',
      field: 'on',
    })
    expect(conflicts[0]?.mine.priority).toBe(1)
    expect(conflicts[0]?.other.priority).toBe(5)
  })

  it('reports no conflict for the same effect', async () => {
    const { svc } = await service()
    await svc.create({ scheduler: holdScheduler(true, 5) })
    expect((await svc.conflicts({ scheduler: holdScheduler(true, 1) })).conflicts).toEqual([])
  })
})
