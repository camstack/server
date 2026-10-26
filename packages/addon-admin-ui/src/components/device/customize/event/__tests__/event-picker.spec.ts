import { describe, expect, it } from 'vitest'
import type { PickerDevice } from '../../source-picker-model'
import { eventPickerLockedIds } from '../event-picker'

const HOST = 100
const SWITCH: PickerDevice = {
  id: 201,
  name: 'Porch switch',
  addonId: 'ha',
  stableId: 'switch.porch',
  location: 'Porch',
  type: 'switch',
  parentDeviceId: null,
}
const CAM: PickerDevice = {
  id: 101,
  name: 'Front camera',
  addonId: 'hik',
  stableId: 'cam',
  location: 'Porch',
  type: 'camera',
  parentDeviceId: null,
}

describe('eventPickerLockedIds', () => {
  it('locks devices that do not carry a declared source cap', () => {
    const index = new Map<number, readonly string[]>([
      [201, ['switch']],
      [101, ['motion', 'stream']],
    ])
    expect(eventPickerLockedIds([SWITCH, CAM], HOST, index, ['binary', 'switch'])).toEqual([101])
  })
})
