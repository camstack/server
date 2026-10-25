import type { ExtensionSlotState } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  linkedCandidates,
  linkedRows,
  type LinkedSlotValue,
  linkedSlotOf,
  orphanTrackedIds,
  withLinked,
  withoutLinked,
  withTracked,
} from '../linked-devices-model'

const VALUE: LinkedSlotValue = {
  slot: 'linked-devices',
  deviceIds: [701, 702],
  trackedDeviceIds: [702],
}
const SLOT: ExtensionSlotState = {
  state: 'ok',
  slotRef: 'device-manager:linked-devices',
  slot: 'linked-devices',
  authority: 'device-manager:_linkedDeviceIds',
  activation: null,
  value: VALUE,
  sources: [
    { deviceId: 701, name: 'Luce porch', health: 'ok' },
    { deviceId: 702, name: 'Sirena esterna', health: 'ok' },
  ],
  impliedSources: [{ deviceId: 710, name: 'Spotlight 1', health: 'ok' }],
}

describe('linkedSlotOf — D315 / D648 rule 5', () => {
  it('pending, failed, an unreachable owner and an answered absence are four different answers', () => {
    expect(linkedSlotOf({ status: 'pending' })).toEqual({ kind: 'pending' })
    expect(linkedSlotOf({ status: 'error', error: { message: 'x' } })).toEqual({
      kind: 'unknown',
      reason: 'x',
    })
    expect(
      linkedSlotOf({
        status: 'success',
        data: [{ state: 'unreachable', addonId: 'device-manager', reason: 'timeout' }],
      }),
    ).toEqual({ kind: 'unknown', reason: 'timeout' })
    expect(linkedSlotOf({ status: 'success', data: [] })).toEqual({ kind: 'absent' })
    expect(linkedSlotOf({ status: 'success', data: [SLOT] }).kind).toBe('present')
  })
})

describe('linked rows and writes', () => {
  it('picks then implied devices; tracked from the stored opt-in', () => {
    expect(linkedRows(SLOT, VALUE)).toEqual([
      { deviceId: 701, name: 'Luce porch', health: 'ok', implied: false, tracked: false },
      { deviceId: 702, name: 'Sirena esterna', health: 'ok', implied: false, tracked: true },
      { deviceId: 710, name: 'Spotlight 1', health: 'ok', implied: true, tracked: false },
    ])
  })
  it('unlinking a pick also drops its tracked opt-in (D655 refuses one outside the linked set)', () => {
    expect(withoutLinked(VALUE, 702)).toEqual({
      slot: 'linked-devices',
      deviceIds: [701],
      trackedDeviceIds: [],
    })
  })
  it('linking appends; the opt-in is written as stored', () => {
    expect(withLinked(VALUE, [703, 701])).toEqual({
      slot: 'linked-devices',
      deviceIds: [701, 702, 703],
      trackedDeviceIds: [702],
    })
  })
  it('tracking toggles one id', () => {
    expect(withTracked(VALUE, 710, true).trackedDeviceIds).toEqual([702, 710])
    expect(withTracked(VALUE, 702, false).trackedDeviceIds).toEqual([])
  })
  it('candidates: not already linked, named from the fleet, the owner`s `suggested` flag ignored', () => {
    const devices = new Map([
      [
        703,
        {
          id: 703,
          name: 'Cancello',
          addonId: 'z',
          stableId: 'z:gate',
          type: 'switch',
          location: 'Garden',
          isCamera: false,
          integration: 'Zigbee',
        },
      ],
    ])
    const out = linkedCandidates(
      [
        {
          deviceId: 701,
          name: 'Luce porch',
          type: 'light',
          location: 'Porch',
          parentName: null,
          suggested: true,
          reason: 'same location',
        },
        {
          deviceId: 703,
          name: 'Cancello',
          type: 'switch',
          location: 'Garden',
          parentName: null,
          suggested: false,
          reason: null,
        },
      ],
      devices,
      new Set([701, 702]),
    )
    expect(out.map((c) => [c.deviceId, c.detail, c.meta])).toEqual([
      [703, 'Zigbee · Garden', 'switch'],
    ])
  })
  it('a stored opt-in outside the linked set is an orphan to show — picks and implied devices are not (review M2)', () => {
    expect(orphanTrackedIds(SLOT, { ...VALUE, trackedDeviceIds: [702, 710, 703] })).toEqual([703])
    expect(orphanTrackedIds(SLOT, { slot: 'linked-devices', deviceIds: [701, 702] })).toEqual([])
  })
})
