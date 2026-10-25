/**
 * `planDevicePrune` / `planTargetPrune` — what the notification centre does to
 * its own stores when a device (or a delivery target) is DELETED.
 *
 * The one rule every row below defends: a prune NEVER WIDENS a rule and never
 * writes an empty list. `conditions.devices: []` means "every camera", and a
 * scoped rule that silently became all-cameras is the 2026-08-12 incident. So
 * the last id of a list is KEPT (it matches nothing, fails closed) and the rule
 * is DISABLED, with the reason recorded.
 */
import { describe, expect, it } from 'vitest'
import { planDevicePrune, planTargetPrune, type NcPruneGuard } from '../device-prune.js'
import { NOTHING_RECORDED, rule, snapshot, summary, timelapse } from './device-prune-fixtures.js'

const DEAD = 102
const LIVE = 101

describe('planDevicePrune — ordinary rules', () => {
  it('removes a deleted id from conditions.devices when others remain', () => {
    const plan = planDevicePrune(
      snapshot({ rules: [rule('r1', { conditions: { devices: [LIVE, DEAD] } })] }),
      new Set([DEAD]),
      NOTHING_RECORDED,
    )
    expect(plan.rules).toHaveLength(1)
    expect(plan.rules[0]?.patch.conditions?.devices).toEqual([LIVE])
    expect(plan.rules[0]?.patch.enabled).toBeUndefined()
    expect(plan.rules[0]?.notes).toEqual([
      expect.objectContaining({ field: 'conditions.devices', outcome: 'removed', subject: '102' }),
    ])
  })

  it('keeps the LAST device id and disables the rule — never widens to all cameras', () => {
    const plan = planDevicePrune(
      snapshot({ rules: [rule('r1', { conditions: { devices: [DEAD] } })] }),
      new Set([DEAD]),
      NOTHING_RECORDED,
    )
    expect(plan.rules[0]?.patch).toEqual({ enabled: false })
    expect(plan.rules[0]?.notes[0]?.outcome).toBe('kept-disabled')
  })

  it('an already-disabled rule is recorded as kept, not written', () => {
    const plan = planDevicePrune(
      snapshot({ rules: [rule('r1', { enabled: false, conditions: { devices: [DEAD] } })] }),
      new Set([DEAD]),
      NOTHING_RECORDED,
    )
    expect(plan.rules[0]?.patch).toEqual({})
    expect(plan.rules[0]?.notes[0]?.outcome).toBe('kept')
  })

  it('systemEvent.deviceIds: shrinks, and the last id is kept (no [] and no key removal)', () => {
    const shrink = planDevicePrune(
      snapshot({
        rules: [
          rule('r1', {
            delivery: 'system-event',
            conditions: { systemEvent: { kinds: ['device-offline'], deviceIds: [LIVE, DEAD] } },
          }),
        ],
      }),
      new Set([DEAD]),
      NOTHING_RECORDED,
    )
    expect(shrink.rules[0]?.patch.conditions?.systemEvent?.deviceIds).toEqual([LIVE])

    const last = planDevicePrune(
      snapshot({
        rules: [
          rule('r1', {
            delivery: 'system-event',
            conditions: { systemEvent: { kinds: ['device-offline'], deviceIds: [DEAD] } },
          }),
        ],
      }),
      new Set([DEAD]),
      NOTHING_RECORDED,
    )
    expect(last.rules[0]?.patch).toEqual({ enabled: false })
    expect(last.rules[0]?.notes[0]).toMatchObject({
      field: 'conditions.systemEvent.deviceIds',
      outcome: 'kept-disabled',
    })
  })

  it('a deviceState gate on a deleted device keeps the id and disables', () => {
    const plan = planDevicePrune(
      snapshot({
        rules: [rule('r1', { conditions: { deviceState: { deviceId: DEAD, states: ['on'] } } })],
      }),
      new Set([DEAD]),
      NOTHING_RECORDED,
    )
    expect(plan.rules[0]?.patch).toEqual({ enabled: false })
    expect(plan.rules[0]?.notes[0]?.field).toBe('conditions.deviceState')
  })

  it('a scene gate whose camera was deleted keeps the id and disables', () => {
    const plan = planDevicePrune(
      snapshot({
        rules: [
          rule('r1', {
            conditions: { scene: { sceneId: 's-1', deviceId: DEAD, requiredState: 'matched' } },
          }),
        ],
      }),
      new Set([DEAD]),
      NOTHING_RECORDED,
    )
    expect(plan.rules[0]?.patch).toEqual({ enabled: false })
    expect(plan.rules[0]?.notes[0]?.field).toBe('conditions.scene')
  })

  it('a recorded last-id case is not disabled again (the operator re-enabled it)', () => {
    const guard: NcPruneGuard = (key) =>
      key.kind === 'rule' && key.ruleId === 'r1' && key.subject === '102'
    const plan = planDevicePrune(
      snapshot({ rules: [rule('r1', { conditions: { devices: [DEAD] } })] }),
      new Set([DEAD]),
      guard,
    )
    expect(plan.rules).toEqual([])
  })

  it('a rule that does not reference the id is untouched', () => {
    const plan = planDevicePrune(
      snapshot({ rules: [rule('r1', { conditions: { devices: [LIVE] } })] }),
      new Set([DEAD]),
      NOTHING_RECORDED,
    )
    expect(plan.rules).toEqual([])
  })
})

describe('planDevicePrune — action sequences', () => {
  const step = (deviceId: number) => ({
    kind: 'cap' as const,
    deviceId,
    cap: 'switch',
    method: 'turnOn',
  })

  it('removes a Do binding on a deleted device and keeps sequence refs + buttons', () => {
    const plan = planDevicePrune(
      snapshot({
        rules: [
          rule('r1', {
            actions: {
              onTrigger: [
                { kind: 'do', action: step(LIVE) },
                { kind: 'do', action: step(DEAD) },
                { kind: 'sequence', sequenceId: 'shared-lights' },
              ],
              buttons: [{ id: 'b1', label: 'Lights', sequenceId: 'shared-lights' }],
            },
          }),
        ],
      }),
      new Set([DEAD]),
      NOTHING_RECORDED,
    )
    const actions = plan.rules[0]?.patch.actions
    expect(actions?.onTrigger).toEqual([
      { kind: 'do', action: step(LIVE) },
      { kind: 'sequence', sequenceId: 'shared-lights' },
    ])
    expect(actions?.buttons).toEqual([{ id: 'b1', label: 'Lights', sequenceId: 'shared-lights' }])
    expect(plan.rules[0]?.patch.enabled).toBeUndefined()
  })

  it('drops a Do binding when its only device is gone', () => {
    const plan = planDevicePrune(
      snapshot({
        rules: [
          rule('r1', {
            actions: {
              onTrigger: [
                { kind: 'do', action: step(DEAD) },
                { kind: 'do', action: step(LIVE) },
              ],
              buttons: [{ id: 'b2', label: 'Lights', sequenceId: 'shared-lights' }],
            },
          }),
        ],
      }),
      new Set([DEAD]),
      NOTHING_RECORDED,
    )
    const actions = plan.rules[0]?.patch.actions
    expect(actions?.onTrigger).toEqual([{ kind: 'do', action: step(LIVE) }])
    expect(actions?.buttons?.map((b) => b.id)).toEqual(['b2'])
    expect(plan.rules[0]?.notes[0]).toMatchObject({ outcome: 'binding-removed' })
    expect(plan.rules[0]?.patch.enabled).toBeUndefined()
  })
})

describe('planDevicePrune — timelapse and summary rules', () => {
  it('timelapse: removes the id and names the generatedByDevice key to forget', () => {
    const plan = planDevicePrune(
      snapshot({
        timelapse: [
          timelapse('t1', { deviceIds: [LIVE, DEAD], generatedByDevice: { '101': 1, '102': 2 } }),
        ],
      }),
      new Set([DEAD]),
      NOTHING_RECORDED,
    )
    expect(plan.timelapse[0]?.patch).toEqual({ deviceIds: [LIVE] })
    expect(plan.timelapse[0]?.forgetDevices).toEqual([DEAD])
  })

  it('timelapse: the last id is kept, the rule disabled, and the stamp kept', () => {
    const plan = planDevicePrune(
      snapshot({ timelapse: [timelapse('t1', { deviceIds: [DEAD] })] }),
      new Set([DEAD]),
      NOTHING_RECORDED,
    )
    expect(plan.timelapse[0]?.patch).toEqual({ enabled: false })
    expect(plan.timelapse[0]?.forgetDevices).toEqual([])
  })

  it('summary: shrinks, and the last id is kept + disabled', () => {
    const shrink = planDevicePrune(
      snapshot({ summary: [summary('s1', { deviceIds: [LIVE, DEAD] })] }),
      new Set([DEAD]),
      NOTHING_RECORDED,
    )
    expect(shrink.summary[0]?.patch).toEqual({ deviceIds: [LIVE] })
    const last = planDevicePrune(
      snapshot({ summary: [summary('s1', { deviceIds: [DEAD] })] }),
      new Set([DEAD]),
      NOTHING_RECORDED,
    )
    expect(last.summary[0]?.patch).toEqual({ enabled: false })
  })
})

describe('planDevicePrune — alarm and mutes', () => {
  it('nonBlocking shrinks per mode (an empty list is fine) and exclusions drop the id', () => {
    const plan = planDevicePrune(
      snapshot({
        alarm: {
          nonBlocking: [
            { mode: 'away', deviceIds: [LIVE, DEAD] },
            { mode: 'night', deviceIds: [DEAD] },
          ],
          blocking: [],
          secureOnArmOff: [],
          announceTargets: [],
          excluded: [DEAD, LIVE],
        },
      }),
      new Set([DEAD]),
      NOTHING_RECORDED,
    )
    expect(plan.alarm?.nonBlocking).toEqual([
      { mode: 'away', deviceIds: [LIVE] },
      { mode: 'night', deviceIds: [] },
    ])
    expect(plan.alarm?.forgetExcluded).toEqual([DEAD])
  })

  it('an alarm that does not reference the id plans nothing', () => {
    const plan = planDevicePrune(
      snapshot({
        alarm: {
          nonBlocking: [{ mode: 'away', deviceIds: [LIVE] }],
          blocking: [],
          secureOnArmOff: [],
          announceTargets: [],
          excluded: [],
        },
      }),
      new Set([DEAD]),
      NOTHING_RECORDED,
    )
    expect(plan.alarm).toBeNull()
  })

  it('a deleted device loses its mute', () => {
    const plan = planDevicePrune(
      snapshot({ mutedDeviceIds: [LIVE, DEAD] }),
      new Set([DEAD]),
      NOTHING_RECORDED,
    )
    expect(plan.unmute).toEqual([DEAD])
  })
})

describe('planTargetPrune', () => {
  it('rule: removes a deleted target when another remains; shrinks disabledTargetIds', () => {
    const plan = planTargetPrune(
      snapshot({
        rules: [
          rule('r1', {
            targets: [{ targetId: 't-1' }, { targetId: 't-dead' }],
            disabledTargetIds: ['t-dead', 't-1'],
          }),
        ],
      }),
      new Set(['t-dead']),
      NOTHING_RECORDED,
    )
    expect(plan.rules[0]?.patch).toEqual({
      targets: [{ targetId: 't-1' }],
      disabledTargetIds: ['t-1'],
    })
  })

  it('rule: the last target with no targetUsers is kept and the rule disabled', () => {
    const plan = planTargetPrune(
      snapshot({ rules: [rule('r1', { targets: [{ targetId: 't-dead' }] })] }),
      new Set(['t-dead']),
      NOTHING_RECORDED,
    )
    expect(plan.rules[0]?.patch).toEqual({ enabled: false })
    expect(plan.rules[0]?.notes[0]).toMatchObject({
      subjectKind: 'target',
      outcome: 'kept-disabled',
    })
  })

  it('rule: the last target MAY go when targetUsers still address someone', () => {
    const plan = planTargetPrune(
      snapshot({
        rules: [rule('r1', { targets: [{ targetId: 't-dead' }], targetUsers: ['u-1'] })],
      }),
      new Set(['t-dead']),
      NOTHING_RECORDED,
    )
    expect(plan.rules[0]?.patch).toEqual({ targets: [] })
  })

  it('timelapse and summary (min 1): the last target is kept + disabled', () => {
    const plan = planTargetPrune(
      snapshot({
        timelapse: [timelapse('t1', { targets: [{ targetId: 't-dead' }] })],
        summary: [summary('s1', { targets: [{ targetId: 't-1' }, { targetId: 't-dead' }] })],
      }),
      new Set(['t-dead']),
      NOTHING_RECORDED,
    )
    expect(plan.timelapse[0]?.patch).toEqual({ enabled: false })
    expect(plan.summary[0]?.patch).toEqual({ targets: [{ targetId: 't-1' }] })
  })

  it('alarm announceTargets shrink', () => {
    const plan = planTargetPrune(
      snapshot({
        alarm: {
          nonBlocking: [],
          blocking: [],
          secureOnArmOff: [],
          announceTargets: ['t-1', 't-dead'],
          excluded: [],
        },
      }),
      new Set(['t-dead']),
      NOTHING_RECORDED,
    )
    expect(plan.alarm?.announceTargets).toEqual(['t-1'])
  })
})
