import {
  type ActionStep,
  type AutomationWhen,
  type SchedulerInput,
  type SchedulerPoint,
  type SchedulerProfile,
  DeviceType,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { ALL_DAYS, at, harness } from './scheduler-support.js'

function turn(on: boolean, target: number | 'domain'): ActionStep {
  return {
    kind: 'cap',
    actionId: on ? 'switch.on' : 'switch.off',
    target: target === 'domain' ? { kind: 'domain' } : { kind: 'devices', ids: [target] },
    cap: 'switch',
    method: 'setState',
    args: { on },
  }
}

function point(
  id: string,
  hh: number,
  mm: number,
  mode: SchedulerPoint['mode'],
  steps: ActionStep[] = [],
  extra: Partial<SchedulerPoint> = {},
): SchedulerPoint {
  return { id, at: { kind: 'clock', hh, mm }, mode, steps, ...extra }
}

function profile(
  points: SchedulerPoint[],
  extra: Partial<SchedulerProfile> = {},
): SchedulerProfile {
  return {
    id: 'p1',
    name: 'P',
    enabled: true,
    days: [...ALL_DAYS],
    points,
    ...extra,
  }
}

function scheduler(
  profiles: SchedulerProfile[],
  extra: Partial<SchedulerInput> = {},
): SchedulerInput {
  return {
    name: 'S',
    enabled: true,
    priority: 0,
    maxLateMs: 600_000,
    profiles,
    ...extra,
  }
}

// 2026-03-10 is a Tuesday, Rome is UTC+1 that day: 07:00 local = 06:00Z.
const MIDNIGHT = at('2026-03-09T23:00:00Z')
const h = (hh: number, mm = 0): number => MIDNIGHT + (hh * 60 + mm) * 60_000

describe('scheduler engine — edges and the queue', () => {
  it('runs an edge at its time, on ONE timer across schedulers, in time order', async () => {
    const w = await harness({
      start: MIDNIGHT,
      devices: [{ id: 1 }, { id: 2 }],
    })
    await w.create(scheduler([profile([point('a', 8, 0, 'edge', [turn(true, 1)])])]))
    await w.create(scheduler([profile([point('b', 7, 0, 'edge', [turn(true, 2)])])]))
    await w.engine.start()
    expect(w.clock.timers.size).toBe(1)
    await w.advanceTo(h(9))
    expect(w.calls.map((c) => c.deviceId)).toEqual([2, 1])
    expect(w.clock.timers.size).toBeLessThanOrEqual(1)
    expect(w.outcomes()).toEqual(['done', 'done'])
  })

  it('keeps wall-clock time across the DST gap in Europe/Rome', async () => {
    // 2026-03-29: 02:00 -> 03:00. A 02:30 point does not exist; it runs at 03:00 local = 01:00Z.
    const start = at('2026-03-28T23:00:00Z')
    const w = await harness({ start, devices: [{ id: 1 }] })
    await w.create(scheduler([profile([point('a', 2, 30, 'edge', [turn(true, 1)])])]))
    await w.engine.start()
    await w.advanceTo(at('2026-03-29T00:59:00Z'))
    expect(w.calls).toHaveLength(0)
    await w.advanceTo(at('2026-03-29T01:05:00Z'))
    expect(w.calls).toHaveLength(1)
    // And the next day it is 02:30 CEST = 00:30Z again.
    await w.advanceTo(at('2026-03-30T00:40:00Z'))
    expect(w.calls).toHaveLength(2)
  })

  it('the first profile in list order wins when two match today', async () => {
    const w = await harness({
      start: MIDNIGHT,
      devices: [{ id: 1 }, { id: 2 }],
    })
    await w.create(
      scheduler([
        profile([point('a', 8, 0, 'edge', [turn(true, 1)])], { id: 'first' }),
        profile([point('b', 8, 0, 'edge', [turn(true, 2)])], { id: 'second' }),
      ]),
    )
    await w.engine.start()
    await w.advanceTo(h(9))
    expect(w.calls.map((c) => c.deviceId)).toEqual([1])
  })

  it('skips a disabled first profile and uses the next one', async () => {
    const w = await harness({
      start: MIDNIGHT,
      devices: [{ id: 1 }, { id: 2 }],
    })
    await w.create(
      scheduler([
        profile([point('a', 8, 0, 'edge', [turn(true, 1)])], {
          id: 'first',
          enabled: false,
        }),
        profile([point('b', 8, 0, 'edge', [turn(true, 2)])], { id: 'second' }),
      ]),
    )
    await w.engine.start()
    await w.advanceTo(h(9))
    expect(w.calls.map((c) => c.deviceId)).toEqual([2])
  })

  it('an activeWhen that is false skips the edge as inactive, and true runs it', async () => {
    const seed = new Map([['9|switch', { on: false }]])
    const w = await harness({ start: MIDNIGHT, devices: [{ id: 1 }], seed })
    const when: AutomationWhen = {
      kind: 'device-is',
      deviceId: 9,
      cap: 'switch',
      fieldPath: 'on',
      operator: 'eq',
      value: true,
    }
    await w.create(
      scheduler(
        [
          profile([
            point('a', 8, 0, 'edge', [turn(true, 1)]),
            point('b', 10, 0, 'edge', [turn(false, 1)]),
          ]),
        ],
        {
          activeWhen: when,
        },
      ),
    )
    await w.engine.start()
    await w.advanceTo(h(8, 30))
    expect(w.outcomes()).toEqual(['inactive'])
    expect(w.calls).toHaveLength(0)
    await w.manual(9, 'switch', { on: true })
    await w.advanceTo(h(10, 30))
    expect(w.outcomes()).toEqual(['inactive', 'done'])
    expect(w.calls).toHaveLength(1)
  })

  it('a point whose conditions are false records condition-false and acts on nothing', async () => {
    const seed = new Map([['9|switch', { on: false }]])
    const w = await harness({ start: MIDNIGHT, devices: [{ id: 1 }], seed })
    const conditions: AutomationWhen = {
      kind: 'device-is',
      deviceId: 9,
      cap: 'switch',
      fieldPath: 'on',
      operator: 'eq',
      value: true,
    }
    await w.create(
      scheduler([profile([point('a', 8, 0, 'edge', [turn(true, 1)], { conditions })])]),
    )
    await w.engine.start()
    await w.advanceTo(h(9))
    expect(w.outcomes()).toEqual(['condition-false'])
    expect(w.calls).toHaveLength(0)
  })

  it('catches up an edge missed during downtime when it is under maxLateMs', async () => {
    const w = await harness({ start: MIDNIGHT, devices: [{ id: 1 }] })
    await w.create(
      scheduler([profile([point('a', 8, 0, 'edge', [turn(true, 1)])])], {
        maxLateMs: 600_000,
      }),
    )
    await w.clock.advanceTo(h(8, 5), async () => undefined) // hub down 00:00..08:05
    await w.engine.start()
    await w.settle()
    expect(w.outcomes()).toEqual(['done'])
    expect(w.calls).toHaveLength(1)
  })

  it('records missed, and does not act, when the edge is over maxLateMs late', async () => {
    const w = await harness({ start: MIDNIGHT, devices: [{ id: 1 }] })
    await w.create(
      scheduler([profile([point('a', 8, 0, 'edge', [turn(true, 1)])])], {
        maxLateMs: 600_000,
      }),
    )
    await w.clock.advanceTo(h(8, 30), async () => undefined)
    await w.engine.start()
    await w.settle()
    expect(w.outcomes()).toEqual(['missed'])
    expect(w.calls).toHaveLength(0)
  })

  it('resolves a domain target at run time: a device added since is included', async () => {
    const w = await harness({ start: MIDNIGHT, devices: [{ id: 1 }] })
    await w.create(scheduler([profile([point('a', 8, 0, 'edge', [turn(true, 'domain')])])]))
    await w.engine.start()
    w.devices.push({ id: 2, type: DeviceType.Switch, location: null, disabled: false })
    w.engine.invalidateTargets()
    await w.advanceTo(h(9))
    expect(w.calls.map((c) => c.deviceId).sort()).toEqual([1, 2])
  })
})

describe('scheduler engine — holds', () => {
  const hold = (extra: Partial<SchedulerPoint> = {}): SchedulerProfile =>
    profile([point('on', 8, 0, 'hold', [turn(true, 1)], extra), point('end', 10, 0, 'release')])

  it('applies the hold when its window opens and ends it at the release without reversing', async () => {
    const w = await harness({
      start: MIDNIGHT,
      devices: [{ id: 1 }],
      seed: new Map([['1|switch', { on: false }]]),
    })
    await w.create(scheduler([hold()]))
    await w.engine.start()
    await w.advanceTo(h(8, 1))
    expect(w.calls).toHaveLength(1)
    expect(w.engine.status()[0]?.hold?.targets[0]?.status).toBe('held')
    await w.advanceTo(h(10, 1))
    expect(w.calls).toHaveLength(1)
    expect(w.engine.status()[0]?.hold).toBeNull()
  })

  it('reconciles to the current window on start (a hub restarted inside the window)', async () => {
    const w = await harness({
      start: h(9),
      devices: [{ id: 1 }],
      seed: new Map([['1|switch', { on: false }]]),
    })
    await w.create(scheduler([hold()]))
    await w.engine.start()
    await w.settle()
    expect(w.calls).toHaveLength(1)
  })

  it('re-applies on drift, bounded by maxHoldAttempts, then gives up', async () => {
    const w = await harness({
      start: h(9),
      devices: [{ id: 1 }],
      seed: new Map([['1|switch', { on: false }]]),
      settleMs: 1_000,
    })
    w.ignoreWrites.value = true
    await w.create(scheduler([hold({ maxHoldAttempts: 2 })]))
    await w.engine.start()
    await w.advanceTo(h(9, 30))
    expect(w.calls).toHaveLength(3) // the first apply + 2 re-applications
    expect(w.engine.status()[0]?.hold?.targets[0]?.status).toBe('gave-up')
    expect(w.outcomes()).toContain('gave-up')
    await w.advanceTo(h(9, 50))
    expect(w.calls).toHaveLength(3)
  })

  it('respects a manual change by default', async () => {
    const w = await harness({
      start: h(9),
      devices: [{ id: 1 }],
      seed: new Map([['1|switch', { on: false }]]),
    })
    await w.create(scheduler([hold()]))
    await w.engine.start()
    await w.settle()
    expect(w.calls).toHaveLength(1)
    await w.manual(1, 'switch', { on: false })
    await w.advanceTo(h(9, 30))
    expect(w.calls).toHaveLength(1)
    expect(w.engine.status()[0]?.hold?.targets[0]?.status).toBe('suspended-manual')
    expect(w.outcomes()).toContain('suspended-manual')
  })

  it('reasserts after graceMs when asked to', async () => {
    const w = await harness({
      start: h(9),
      devices: [{ id: 1 }],
      seed: new Map([['1|switch', { on: false }]]),
    })
    await w.create(scheduler([hold({ override: { mode: 'reassert', graceMs: 5 * 60_000 } })]))
    await w.engine.start()
    await w.settle()
    await w.manual(1, 'switch', { on: false })
    await w.advanceTo(h(9, 3))
    expect(w.calls).toHaveLength(1)
    await w.advanceTo(h(9, 7))
    expect(w.calls).toHaveLength(2)
  })

  it('does not treat its own write as a manual change', async () => {
    const w = await harness({
      start: h(9),
      devices: [{ id: 1 }],
      seed: new Map([['1|switch', { on: false }]]),
    })
    await w.create(scheduler([hold()]))
    await w.engine.start()
    await w.settle()
    await w.advanceTo(h(9, 30))
    expect(w.engine.status()[0]?.hold?.targets[0]?.status).toBe('held')
    expect(w.outcomes()).not.toContain('suspended-manual')
  })

  it('suspends a hold while activeWhen is false, without reversing it', async () => {
    const seed = new Map<string, Record<string, unknown>>([
      ['1|switch', { on: false }],
      ['9|switch', { on: true }],
    ])
    const w = await harness({ start: h(9), devices: [{ id: 1 }], seed })
    const activeWhen: AutomationWhen = {
      kind: 'device-is',
      deviceId: 9,
      cap: 'switch',
      fieldPath: 'on',
      operator: 'eq',
      value: true,
    }
    await w.create(scheduler([hold()], { activeWhen }))
    await w.engine.start()
    await w.settle()
    expect(w.calls).toHaveLength(1)
    await w.manual(9, 'switch', { on: false })
    expect(w.engine.status()[0]?.hold?.suspendedInactive).toBe(true)
    expect(w.calls).toHaveLength(1)
  })

  it('the higher priority holds a device; the lower is overridden', async () => {
    const w = await harness({
      start: h(9),
      devices: [{ id: 1 }],
      seed: new Map([['1|switch', { on: false }]]),
    })
    const lowId = await w.create(
      scheduler(
        [profile([point('on', 8, 0, 'hold', [turn(true, 1)]), point('end', 10, 0, 'release')])],
        { priority: 1 },
      ),
    )
    const highId = await w.create(
      scheduler(
        [profile([point('off', 8, 0, 'hold', [turn(false, 1)]), point('end', 10, 0, 'release')])],
        { priority: 5 },
      ),
    )
    await w.engine.start()
    await w.settle()
    expect(w.slices.get('1|switch')).toEqual({ on: false })
    expect(w.outcomes(lowId)).toContain('overridden')
    expect(w.outcomes(highId)).toContain('held')
  })
})
