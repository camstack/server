import { describe, it, expect } from 'vitest'
import type { ProfileSlot } from '@camstack/types'
import {
  computeDispatchGap,
  desiredDeviceIdsFromSlots,
  reconcilePlacement,
  reconcileVanishedDevices,
  splitDesiredByExistence,
  pickMotionRolePlacement,
  decideSessionAction,
} from '../dispatch-reconcile.js'

function makeSlot(overrides: Partial<ProfileSlot>): ProfileSlot {
  return {
    deviceId: 1,
    profile: 'high',
    brokerId: '1/high',
    sourceCamStreamId: 'rtsp:main',
    status: 'streaming',
    ...overrides,
  }
}

describe('desiredDeviceIdsFromSlots', () => {
  it('returns only deviceIds of slots that are assigned with a non-null source', () => {
    const slots: readonly ProfileSlot[] = [
      // assigned with source — device 1
      makeSlot({ deviceId: 1, status: 'streaming', sourceCamStreamId: 'rtsp:main' }),
      // unassigned — must be excluded
      makeSlot({ deviceId: 2, status: 'unassigned', sourceCamStreamId: null }),
      // assigned but null source — must be excluded
      makeSlot({ deviceId: 3, status: 'idle', sourceCamStreamId: null }),
      // assigned with source — device 4
      makeSlot({ deviceId: 4, status: 'idle', sourceCamStreamId: 'rtsp:sub' }),
      // second profile for device 1 — must not duplicate device 1 in result
      makeSlot({
        deviceId: 1,
        profile: 'mid',
        brokerId: '1/mid',
        status: 'connecting',
        sourceCamStreamId: 'rtsp:sub',
      }),
    ]

    const result = desiredDeviceIdsFromSlots(slots)

    expect(result.size).toBe(2)
    expect(result.has(1)).toBe(true)
    expect(result.has(4)).toBe(true)
    expect(result.has(2)).toBe(false)
    expect(result.has(3)).toBe(false)
  })
})

describe('computeDispatchGap', () => {
  it('returns deviceIds in desired that are absent from known', () => {
    const desired = new Set([1, 2, 3, 4, 5, 6, 7, 8])
    const known = new Set([1, 2, 3])

    const gap = computeDispatchGap(desired, known)

    expect(gap.toSorted((a, b) => a - b)).toEqual([4, 5, 6, 7, 8])
  })

  it('returns an empty array when desired is a subset of known', () => {
    const desired = new Set([1, 2])
    const known = new Set([1, 2, 3, 4])

    const gap = computeDispatchGap(desired, known)

    expect(gap).toEqual([])
  })
})

describe('splitDesiredByExistence', () => {
  it('splits the desired fleet into devices the registry still has and ones it does not', () => {
    const split = splitDesiredByExistence(new Set([1, 2, 3217, 3218]), new Set([1, 2, 9]))

    expect([...split.existing].toSorted((a, b) => a - b)).toEqual([1, 2])
    expect([...split.vanished].toSorted((a, b) => a - b)).toEqual([3217, 3218])
  })

  it('treats a live registry that is a superset of desired as all-existing', () => {
    const split = splitDesiredByExistence(new Set([1]), new Set([1, 2, 3]))

    expect([...split.existing]).toEqual([1])
    expect([...split.vanished]).toEqual([])
  })
})

describe('reconcileVanishedDevices', () => {
  it('does NOT tear down on the first pass a device is missing (one read never destroys work)', () => {
    const out = reconcileVanishedDevices(new Set([3217]), new Map())

    expect(out.tearDown).toEqual([])
    expect(out.nextState.get(3217)).toBe('first-pass')
  })

  it('tears down only once the SECOND consecutive pass agrees the device is gone', () => {
    const first = reconcileVanishedDevices(new Set([3217]), new Map())
    const second = reconcileVanishedDevices(new Set([3217]), first.nextState)

    expect(second.tearDown).toEqual([3217])
    expect(second.nextState.get(3217)).toBe('torn-down')
  })

  it('never tears the same device down twice while it stays vanished', () => {
    const first = reconcileVanishedDevices(new Set([3217]), new Map())
    const second = reconcileVanishedDevices(new Set([3217]), first.nextState)
    const third = reconcileVanishedDevices(new Set([3217]), second.nextState)

    expect(third.tearDown).toEqual([])
    expect(third.nextState.get(3217)).toBe('torn-down')
  })

  it('forgets a device that reappears, so a later re-deletion needs two fresh passes again', () => {
    const first = reconcileVanishedDevices(new Set([3217]), new Map())
    const reappeared = reconcileVanishedDevices(new Set(), first.nextState)
    expect(reappeared.nextState.has(3217)).toBe(false)

    const goneAgain = reconcileVanishedDevices(new Set([3217]), reappeared.nextState)
    expect(goneAgain.tearDown).toEqual([])
    expect(goneAgain.nextState.get(3217)).toBe('first-pass')
  })

  it('tracks each device independently', () => {
    const first = reconcileVanishedDevices(new Set([3217]), new Map())
    const second = reconcileVanishedDevices(new Set([3217, 3218]), first.nextState)

    expect(second.tearDown).toEqual([3217])
    expect(second.nextState.get(3218)).toBe('first-pass')
  })
})

describe('reconcilePlacement', () => {
  it('detaches a camera attached where it is NOT assigned (orphan/migration leak)', () => {
    const out = reconcilePlacement({
      runners: [
        { nodeId: 'hub', attached: [10] },
        { nodeId: 'agent', attached: [10] }, // 10 assigned to hub → agent copy is a duplicate
      ],
      assignedNodeById: new Map([[10, 'hub']]),
      dispatching: new Set(),
      idleSessionDeviceIds: new Set(),
      motionWatchAttachments: new Set(),
    })
    expect(out.detach).toEqual([{ nodeId: 'agent', deviceId: 10 }])
    expect(out.dropStaleAssignment).toEqual([])
  })

  it('drops a stale assignment when no runner reports the camera attached', () => {
    const out = reconcilePlacement({
      runners: [{ nodeId: 'hub', attached: [] }],
      assignedNodeById: new Map([[10, 'hub']]), // assigned to hub but hub has nothing
      dispatching: new Set(),
      idleSessionDeviceIds: new Set(),
      motionWatchAttachments: new Set(),
    })
    expect(out.dropStaleAssignment).toEqual([10])
    expect(out.detach).toEqual([])
  })

  it('leaves an unassigned attachment alone (boot-race safety) but still not stale', () => {
    const out = reconcilePlacement({
      runners: [{ nodeId: 'agent', attached: [10] }],
      assignedNodeById: new Map(), // no assignment at all
      dispatching: new Set(),
      idleSessionDeviceIds: new Set(),
      motionWatchAttachments: new Set(),
    })
    expect(out.detach).toEqual([]) // unassigned → not an orphan
    expect(out.dropStaleAssignment).toEqual([]) // no assignment to drop
  })

  it('detaches an unassigned idle session camera left on a runner', () => {
    const out = reconcilePlacement({
      runners: [{ nodeId: 'mac', attached: [112] }],
      assignedNodeById: new Map(),
      dispatching: new Set(),
      idleSessionDeviceIds: new Set([112]),
      motionWatchAttachments: new Set(),
    })
    expect(out.detach).toEqual([{ nodeId: 'mac', deviceId: 112 }])
  })

  it('keeps an intentional analyzer motion-watch attachment', () => {
    const out = reconcilePlacement({
      runners: [{ nodeId: 'motion-node', attached: [587] }],
      assignedNodeById: new Map(),
      dispatching: new Set(),
      idleSessionDeviceIds: new Set([112]),
      motionWatchAttachments: new Set(['motion-node:587']),
    })
    expect(out.detach).toEqual([])
  })

  it('never detaches or drops a dispatching (in-flight) device', () => {
    const out = reconcilePlacement({
      runners: [{ nodeId: 'agent', attached: [10] }],
      assignedNodeById: new Map([[10, 'hub']]),
      dispatching: new Set([10]),
      idleSessionDeviceIds: new Set([10]),
      motionWatchAttachments: new Set(),
    })
    expect(out.detach).toEqual([])
    expect(out.dropStaleAssignment).toEqual([])
  })

  it('keeps a correctly-placed camera untouched', () => {
    const out = reconcilePlacement({
      runners: [{ nodeId: 'hub', attached: [10] }],
      assignedNodeById: new Map([[10, 'hub']]),
      dispatching: new Set(),
      idleSessionDeviceIds: new Set(),
      motionWatchAttachments: new Set(),
    })
    expect(out.detach).toEqual([])
    expect(out.dropStaleAssignment).toEqual([])
  })

  it('does NOT drop assignments for a node that failed to report (absent from runners)', () => {
    const out = reconcilePlacement({
      runners: [{ nodeId: 'hub', attached: [10] }], // 'agent' failed to answer → omitted from runners
      assignedNodeById: new Map([
        [10, 'hub'],
        [20, 'agent'],
      ]),
      dispatching: new Set(),
      idleSessionDeviceIds: new Set(),
      motionWatchAttachments: new Set(),
    })
    expect(out.dropStaleAssignment).toEqual([]) // 20 (on the silent node) must survive
    expect(out.detach).toEqual([])
  })
})

describe('pickMotionRolePlacement', () => {
  const base = {
    isAnalyzer: true,
    hasPin: false,
    motionNode: 'motion-1',
    loadedNodeIds: ['hub', 'motion-1'],
    eligibleNodeIds: ['hub', 'motion-1'],
  }

  it('places an analyzer camera on the motionNode when it is loadable + eligible', () => {
    expect(pickMotionRolePlacement(base)).toBe('motion-1')
  })

  it('returns null for a non-analyzer (onboard/always-on) camera', () => {
    expect(pickMotionRolePlacement({ ...base, isAnalyzer: false })).toBeNull()
  })

  it('returns null when an explicit per-device pin is set (pin wins)', () => {
    expect(pickMotionRolePlacement({ ...base, hasPin: true })).toBeNull()
  })

  it('returns null when the motionNode is not currently loadable (offline) → balancer fallback', () => {
    expect(pickMotionRolePlacement({ ...base, loadedNodeIds: ['hub'] })).toBeNull()
  })

  it('returns null when the motionNode is not detection-eligible for this camera → balancer fallback', () => {
    expect(pickMotionRolePlacement({ ...base, eligibleNodeIds: ['hub'] })).toBeNull()
  })
})

describe('decideSessionAction', () => {
  const base = {
    detectionMode: 'on-motion' as const,
    detected: true,
    hasActiveSession: false,
    hasStandingAttach: false,
  }

  it('dispatches on motion for an idle on-motion camera', () => {
    expect(decideSessionAction(base)).toBe('dispatch')
  })
  it('ignores when the camera still has a standing attach (pre-cutover / always-on path)', () => {
    expect(decideSessionAction({ ...base, hasStandingAttach: true })).toBe('ignore')
  })
  it('ignores non on-motion modes (always-on stays standing, disabled does nothing)', () => {
    expect(decideSessionAction({ ...base, detectionMode: 'always-on' })).toBe('ignore')
    expect(decideSessionAction({ ...base, detectionMode: 'disabled' })).toBe('ignore')
  })
  it('re-dispatches (idempotent refresh) when motion re-fires during an active session', () => {
    expect(decideSessionAction({ ...base, hasActiveSession: true })).toBe('dispatch')
  })
  it('tears down when motion clears and a session is active', () => {
    expect(decideSessionAction({ ...base, detected: false, hasActiveSession: true })).toBe(
      'teardown',
    )
  })
  it('ignores a motion-clear when no session is active', () => {
    expect(decideSessionAction({ ...base, detected: false, hasActiveSession: false })).toBe(
      'ignore',
    )
  })
})
