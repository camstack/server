import { describe, expect, it } from 'vitest'
import {
  type AssignmentFacts,
  type CustomizeOffer,
  assignmentAvailability,
  nativeCapNames,
} from '../assignment-availability'

const known = <T>(value: T) => ({ kind: 'known', value }) as const
const CAMERA: AssignmentFacts = {
  deviceType: 'camera',
  composable: known(new Set(['doorbell', 'battery'])),
  nativeCaps: known(new Set(['motion'])),
  cameraSensors: 'present',
}

const DOORBELL: CustomizeOffer = {
  cap: 'doorbell',
  apply: 'add',
  authority: 'composition-claim',
  nativeItemsReadOnly: false,
}
const BATTERY: CustomizeOffer = {
  cap: 'battery',
  apply: 'add',
  authority: 'composition-claim',
  nativeItemsReadOnly: false,
}
const RUNNING: CustomizeOffer = {
  cap: 'running-state',
  apply: 'add',
  authority: 'composition-claim',
  nativeItemsReadOnly: false,
}
const CONSUMABLES: CustomizeOffer = {
  cap: 'consumables',
  apply: 'add',
  authority: 'composition-claim',
  nativeItemsReadOnly: true,
}
const MOTION: CustomizeOffer = {
  cap: 'motion',
  apply: 'add',
  authority: 'camera-sensors',
  nativeItemsReadOnly: false,
}

const DOOR_CONTACT: CustomizeOffer = {
  cap: 'lock-control',
  apply: 'replace',
  authority: 'composition-claim',
  nativeItemsReadOnly: false,
}

describe('assignmentAvailability — a declared replace (D984)', () => {
  const LOCK: AssignmentFacts = {
    deviceType: 'lock',
    composable: known(new Set<string>()),
    nativeCaps: known(new Set(['lock-control'])),
    cameraSensors: 'absent',
  }
  it('is offered on a lock that serves lock-control itself', () => {
    expect(assignmentAvailability(DOOR_CONTACT, LOCK)).toEqual({
      kind: 'present',
      mode: 'replace',
    })
  })
  it('is absent where the device has no lock-control to override', () => {
    expect(
      assignmentAvailability(DOOR_CONTACT, { ...LOCK, nativeCaps: known(new Set<string>()) }),
    ).toEqual({ kind: 'absent' })
  })
})

describe('assignmentAvailability — four answered states (D315, D676 ruling 13)', () => {
  it('a doorbell is offered where it can be composed and the device has none of its own', () => {
    expect(assignmentAvailability(DOORBELL, CAMERA)).toEqual({ kind: 'present', mode: 'add' })
    expect(
      assignmentAvailability(DOORBELL, { ...CAMERA, nativeCaps: known(new Set(['doorbell'])) }),
    ).toEqual({ kind: 'absent' })
  })
  it('running-state is offered only where the device has none of its own', () => {
    const composableRunning: AssignmentFacts = {
      ...CAMERA,
      composable: known(new Set(['running-state'])),
    }
    expect(assignmentAvailability(RUNNING, composableRunning)).toEqual({
      kind: 'present',
      mode: 'add',
    })
    expect(
      assignmentAvailability(RUNNING, {
        ...CAMERA,
        composable: known(new Set(['running-state'])),
        nativeCaps: known(new Set(['running-state'])),
      }),
    ).toEqual({ kind: 'absent' })
  })
  it('battery is offered only where the device has none of its own', () => {
    expect(assignmentAvailability(BATTERY, CAMERA)).toEqual({ kind: 'present', mode: 'add' })
    expect(
      assignmentAvailability(BATTERY, { ...CAMERA, nativeCaps: known(new Set(['battery'])) }),
    ).toEqual({ kind: 'absent' })
  })
  it('consumables stay addable when the device already has native items (keyed-array §6.4)', () => {
    const feeder: AssignmentFacts = {
      ...CAMERA,
      deviceType: 'pet-feeder',
      composable: known(new Set(['consumables'])),
    }
    expect(assignmentAvailability(CONSUMABLES, feeder)).toEqual({ kind: 'present', mode: 'add' })
    expect(
      assignmentAvailability(CONSUMABLES, {
        ...feeder,
        nativeCaps: known(new Set(['consumables'])),
      }),
    ).toEqual({ kind: 'present', mode: 'add' })
  })
  it('an unread fact is pending or unknown — never absent', () => {
    expect(
      assignmentAvailability(DOORBELL, { ...CAMERA, nativeCaps: { kind: 'pending' } }),
    ).toEqual({ kind: 'pending' })
    expect(
      assignmentAvailability(BATTERY, {
        ...CAMERA,
        composable: { kind: 'unknown', reason: 'older server' },
      }),
    ).toEqual({ kind: 'unknown', reason: 'older server' })
  })
  it('motion exists only on a camera whose orchestrator reports camera sensors', () => {
    expect(assignmentAvailability(MOTION, CAMERA)).toEqual({ kind: 'present', mode: 'add' })
    expect(assignmentAvailability(MOTION, { ...CAMERA, cameraSensors: 'pending' })).toEqual({
      kind: 'pending',
    })
    expect(assignmentAvailability(MOTION, { ...CAMERA, cameraSensors: 'unknown' }).kind).toBe(
      'unknown',
    )
    expect(assignmentAvailability(MOTION, { ...CAMERA, cameraSensors: 'absent' })).toEqual({
      kind: 'absent',
    })
    expect(assignmentAvailability(MOTION, { ...CAMERA, deviceType: 'sensor' })).toEqual({
      kind: 'absent',
    })
  })
})

describe('nativeCapNames — the validator rule (G8)', () => {
  it('a blank owner and the composer are not native', () => {
    expect([
      ...nativeCapNames([
        { capName: 'motion', nativeAddonId: 'provider-reolink' },
        { capName: 'doorbell', nativeAddonId: ' ' },
        { capName: 'battery', nativeAddonId: 'composer' },
      ]),
    ]).toEqual(['motion'])
  })
})
