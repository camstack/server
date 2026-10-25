/**
 * The PURE rebalance planner: which piles of EXISTING footage have to move for
 * the archive to agree with the placement plan, and which deliberately do not.
 *
 * D116 draws the line this file sits on: the placement plan decides where NEW
 * writes go and nothing about it moves a byte. Moving bytes is operator-armed,
 * and this is the arithmetic that operator sees before arming it.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MIN_MOVE_BYTES,
  planRebalance,
  type RebalanceHeadroom,
  type RebalanceSource,
} from '../addon/rebalance-plan.js'

const GB = 1_000_000_000

function source(
  deviceId: number,
  profile: string,
  locationId: string,
  gb: number,
  files = 100,
): RebalanceSource {
  return { deviceId, profile, locationId, bytes: gb * GB, files }
}

function roomy(...ids: readonly string[]): readonly RebalanceHeadroom[] {
  return ids.map((locationId) => ({ locationId, headroomBytes: 1_000 * GB }))
}

const ASSIGNED_TO_NAS = new Map([
  ['101:high', 'recordings:nas'],
  ['102:high', 'recordings:nas'],
])

describe('planRebalance', () => {
  it('says nothing about footage that already sits where the plan wants it', () => {
    const plan = planRebalance({
      assignments: ASSIGNED_TO_NAS,
      sources: [source(101, 'high', 'recordings:nas', 50)],
      headroom: roomy('recordings:nas', 'recordings:default'),
    })
    expect(plan.moves).toEqual([])
    expect(plan.skipped).toEqual([])
    expect(plan.bytesToMove).toBe(0)
  })

  it('moves a pile that sits on the wrong location, per (camera, profile)', () => {
    const plan = planRebalance({
      assignments: ASSIGNED_TO_NAS,
      sources: [
        source(101, 'high', 'recordings:default', 50, 4_000),
        source(102, 'high', 'recordings:default', 20, 1_500),
      ],
      headroom: roomy('recordings:nas', 'recordings:default'),
    })
    expect(plan.moves).toEqual([
      {
        deviceId: 101,
        profile: 'high',
        fromLocationId: 'recordings:default',
        toLocationId: 'recordings:nas',
        bytes: 50 * GB,
        files: 4_000,
      },
      {
        deviceId: 102,
        profile: 'high',
        fromLocationId: 'recordings:default',
        toLocationId: 'recordings:nas',
        bytes: 20 * GB,
        files: 1_500,
      },
    ])
    expect(plan.bytesToMove).toBe(70 * GB)
    expect(plan.skipped).toEqual([])
  })

  it('orders the moves BIGGEST first — the overloaded disk is relieved fastest', () => {
    const plan = planRebalance({
      assignments: new Map([
        ['101:high', 'recordings:nas'],
        ['102:high', 'recordings:nas'],
        ['108:high', 'recordings:nas'],
      ]),
      sources: [
        source(101, 'high', 'recordings:default', 5),
        source(102, 'high', 'recordings:default', 90),
        source(108, 'high', 'recordings:default', 40),
      ],
      headroom: roomy('recordings:nas'),
    })
    expect(plan.moves.map((m) => m.deviceId)).toEqual([102, 108, 101])
  })

  it('never plans a move a camera has no assignment for', () => {
    const plan = planRebalance({
      assignments: new Map(),
      sources: [source(101, 'high', 'recordings:default', 50)],
      headroom: roomy('recordings:nas', 'recordings:default'),
    })
    expect(plan.moves).toEqual([])
    expect(plan.skipped).toEqual([
      {
        deviceId: 101,
        profile: 'high',
        fromLocationId: 'recordings:default',
        toLocationId: null,
        bytes: 50 * GB,
        reason: 'unassigned',
      },
    ])
  })

  it('refuses a target the mover could not write to — read-only, opted out, or gone', () => {
    const plan = planRebalance({
      assignments: ASSIGNED_TO_NAS,
      sources: [source(101, 'high', 'recordings:default', 50)],
      // The NAS is not in the headroom list at all: it is not a write target.
      headroom: roomy('recordings:default'),
    })
    expect(plan.moves).toEqual([])
    expect(plan.skipped[0]?.reason).toBe('target-not-writable')
    expect(plan.skipped[0]?.toLocationId).toBe('recordings:nas')
  })

  it('leaves a pile smaller than the threshold alone — the move costs more than it fixes', () => {
    const plan = planRebalance({
      assignments: ASSIGNED_TO_NAS,
      sources: [source(101, 'high', 'recordings:default', 0.4)],
      headroom: roomy('recordings:nas'),
    })
    expect(plan.moves).toEqual([])
    expect(plan.skipped[0]?.reason).toBe('below-threshold')
  })

  it('honours an operator-supplied threshold', () => {
    const input = {
      assignments: ASSIGNED_TO_NAS,
      sources: [source(101, 'high', 'recordings:default', 0.4)],
      headroom: roomy('recordings:nas'),
    }
    expect(planRebalance({ ...input, minMoveBytes: 0 }).moves).toHaveLength(1)
    expect(DEFAULT_MIN_MOVE_BYTES).toBe(1 * GB)
  })

  it('spends each target’s headroom ONCE — a pile that no longer fits is refused, not truncated', () => {
    const plan = planRebalance({
      assignments: new Map([
        ['101:high', 'recordings:nas'],
        ['102:high', 'recordings:nas'],
      ]),
      sources: [
        source(101, 'high', 'recordings:default', 80),
        source(102, 'high', 'recordings:default', 60),
      ],
      headroom: [{ locationId: 'recordings:nas', headroomBytes: 100 * GB }],
    })
    // Biggest first: 80 GB fits, 60 GB no longer does. The remainder is NOT
    // partially moved — the mover's unit is a whole pile of index rows.
    expect(plan.moves.map((m) => m.deviceId)).toEqual([101])
    expect(plan.skipped).toEqual([
      {
        deviceId: 102,
        profile: 'high',
        fromLocationId: 'recordings:default',
        toLocationId: 'recordings:nas',
        bytes: 60 * GB,
        reason: 'no-headroom',
      },
    ])
    expect(plan.bytesToMove).toBe(80 * GB)
  })

  it('never credits the SOURCE’s headroom — the bytes are not free until they land', () => {
    // 101 leaves `default` for the NAS; 102 wants to come the other way. The
    // 100 GB `default` frees up must NOT fund 102's move: the copy has not run.
    const plan = planRebalance({
      assignments: new Map([
        ['101:high', 'recordings:nas'],
        ['102:high', 'recordings:default'],
      ]),
      sources: [
        source(101, 'high', 'recordings:default', 100),
        source(102, 'high', 'recordings:nas', 30),
      ],
      headroom: [
        { locationId: 'recordings:nas', headroomBytes: 1_000 * GB },
        { locationId: 'recordings:default', headroomBytes: 10 * GB },
      ],
    })
    expect(plan.moves.map((m) => m.deviceId)).toEqual([101])
    expect(plan.skipped.map((s) => [s.deviceId, s.reason])).toEqual([[102, 'no-headroom']])
  })

  it('is PURE — the same input yields the same plan, and the input is untouched', () => {
    const sources = [
      source(101, 'high', 'recordings:default', 50),
      source(102, 'low', 'recordingsLow:default', 20),
    ]
    const frozen = JSON.stringify(sources)
    const input = {
      assignments: new Map([
        ['101:high', 'recordings:nas'],
        ['102:low', 'recordingsLow:nas'],
      ]),
      sources,
      headroom: roomy('recordings:nas', 'recordingsLow:nas'),
    }
    expect(planRebalance(input)).toEqual(planRebalance(input))
    expect(JSON.stringify(sources)).toBe(frozen)
  })

  it('plans one move per PROFILE — high and low are separate piles on separate pools', () => {
    const plan = planRebalance({
      assignments: new Map([
        ['101:high', 'recordings:nas'],
        ['101:low', 'recordingsLow:nas'],
      ]),
      sources: [
        source(101, 'high', 'recordings:default', 50),
        source(101, 'low', 'recordingsLow:default', 10),
      ],
      headroom: roomy('recordings:nas', 'recordingsLow:nas'),
    })
    expect(plan.moves.map((m) => [m.profile, m.toLocationId])).toEqual([
      ['high', 'recordings:nas'],
      ['low', 'recordingsLow:nas'],
    ])
  })
})
