import { describe, it, expect } from 'vitest'
import { readDeviceStateFrom } from '../device-state-vocabulary.js'

describe('DEVICE_STATE_READERS — locks', () => {
  it('reads the real lock-control slice', () => {
    expect(readDeviceStateFrom({ 'lock-control': { state: 'unlocked', lastChangedAt: 1 } })).toBe(
      'unlocked',
    )
    expect(readDeviceStateFrom({ 'lock-control': { state: 'locked', lastChangedAt: 1 } })).toBe(
      'locked',
    )
  })
})
