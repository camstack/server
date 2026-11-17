/**
 * Moving the speed slider while the purifier runs a preset (Auto, Sleep) switches it to Manual
 * first, then sets the speed: VeSync ignores a speed while a preset drives the fan.
 */
import { describe, expect, it } from 'vitest'
import type { VeSyncPurifierSnapshot } from '../vesync-client-contract.js'
import { planPurifierSpeed } from '../vesync-commands.js'

function purifier(over: Partial<VeSyncPurifierSnapshot>): VeSyncPurifierSnapshot {
  return {
    kind: 'purifier',
    nativeId: 'cid-1',
    name: 'Purifier',
    power: true,
    speedPercent: 33,
    preset: '',
    availablePresets: ['auto', 'sleep'],
    childLock: false,
    display: true,
    filterLifePercent: 90,
    online: true,
    ...over,
  }
}

describe('planPurifierSpeed', () => {
  it('in Manual: only the speed', () => {
    expect(planPurifierSpeed(purifier({}), 67)).toEqual([{ kind: 'speed', percent: 67 }])
  })

  it('in Auto: Manual first, then the speed', () => {
    expect(planPurifierSpeed(purifier({ preset: 'auto' }), 67)).toEqual([
      { kind: 'mode', mode: 'manual' },
      { kind: 'speed', percent: 67 },
    ])
  })

  it('in Sleep: Manual first, then the speed', () => {
    expect(planPurifierSpeed(purifier({ preset: 'sleep' }), 100)).toEqual([
      { kind: 'mode', mode: 'manual' },
      { kind: 'speed', percent: 100 },
    ])
  })

  it('off: power on, Manual when a preset is set, then the speed', () => {
    expect(planPurifierSpeed(purifier({ power: false, preset: 'auto' }), 34)).toEqual([
      { kind: 'power', on: true },
      { kind: 'mode', mode: 'manual' },
      { kind: 'speed', percent: 34 },
    ])
  })

  it('zero turns it off and sends nothing else', () => {
    expect(planPurifierSpeed(purifier({ preset: 'auto' }), 0)).toEqual([
      { kind: 'power', on: false },
    ])
  })
})
