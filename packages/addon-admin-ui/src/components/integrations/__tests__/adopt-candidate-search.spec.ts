import { describe, it, expect } from 'vitest'
import { DeviceType, type DiscoveredChildDevice } from '@camstack/types'

import { candidateSearchText } from '../adopt-candidate-search'

/**
 * `candidateSearchText` — pure helper exercised WITHOUT rendering the modal.
 * It emulates Home Assistant's multi-field device search (name + model +
 * manufacturer + integration + area), so a substring search finds a device
 * by its metadata even when the friendly name carries none of those tokens.
 */
describe('candidateSearchText', () => {
  const robot: DiscoveredChildDevice = {
    childNativeId: 'ha:dev:robot',
    name: 'Robot piano terra',
    type: DeviceType.Generic,
    status: 'online',
    metadata: {
      model: 'dreame.vacuum.r2538z',
      manufacturer: 'Dreametech™',
      integration: 'dreame_vacuum',
      externalLocation: 'Hall',
    },
    alreadyAdopted: false,
    adoptedDeviceId: null,
  }

  it('folds name + childNativeId + model + manufacturer + integration + area into one text', () => {
    const text = candidateSearchText(robot)
    expect(text).toContain('Robot piano terra')
    expect(text).toContain('ha:dev:robot')
    expect(text).toContain('dreame.vacuum.r2538z')
    expect(text).toContain('Dreametech™')
    expect(text).toContain('dreame_vacuum')
    expect(text).toContain('Hall')
  })

  it('matches a brandless device by metadata substrings', () => {
    const text = candidateSearchText(robot).toLowerCase()
    for (const term of ['dreame', 'dreametech', 'r2538z', 'dreame_vacuum']) {
      expect(text.includes(term.toLowerCase())).toBe(true)
    }
  })

  it('skips undefined metadata fields — no "undefined" and no double spaces', () => {
    const sparse: DiscoveredChildDevice = {
      childNativeId: 'reolink:ch0',
      name: 'Channel 0',
      type: DeviceType.Camera,
      status: 'online',
      metadata: {},
      alreadyAdopted: false,
      adoptedDeviceId: null,
    }
    const text = candidateSearchText(sparse)
    expect(text).toBe('Channel 0 reolink:ch0')
    expect(text).not.toContain('undefined')
    expect(text).not.toContain('  ')
  })
})
