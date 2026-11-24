import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { connectedCardKindOf } from '../../packages/ui-library/src/composites/device-card/connected/connected-card-kind.js'
import {
  coverageProblems,
  DEVICE_TYPE_CARD_EXEMPTIONS,
  RESOLVER_CAPS,
} from '../check-device-type-card-coverage.js'

describe('coverageProblems', () => {
  const types = ['lock', 'camera', 'ghost']
  const resolves = (type: string): boolean => type === 'lock'

  it('a type with no card and no exemption is a problem', () => {
    expect(coverageProblems(types, resolves, {})).toEqual([
      { type: 'camera', problem: 'resolves to no card and has no named exemption' },
      { type: 'ghost', problem: 'resolves to no card and has no named exemption' },
    ])
  })

  it('a named exemption clears it', () => {
    expect(coverageProblems(types, resolves, { camera: 'stream panel', ghost: 'n/a' })).toEqual([])
  })

  it('an exemption for a type that resolves is stale', () => {
    expect(coverageProblems(types, resolves, { lock: 'old', camera: 'x', ghost: 'y' })).toEqual([
      { type: 'lock', problem: 'is exempt but resolves to a card: drop the exemption' },
    ])
  })

  it('an exemption for a type that does not exist is an error', () => {
    expect(coverageProblems(types, resolves, { camera: 'x', ghost: 'y', unicorn: 'z' })).toEqual([
      { type: 'unicorn', problem: 'is exempt but is not a DeviceType' },
    ])
  })

  it('a blank reason is no reason', () => {
    expect(coverageProblems(['camera'], () => false, { camera: ' ' })).toHaveLength(1)
  })
})

describe('the real DeviceType table', () => {
  it('every device type resolves to a shell card or is named in the exemptions', () => {
    expect(
      coverageProblems(
        Object.values(DeviceType),
        (type) => connectedCardKindOf(type, null, RESOLVER_CAPS) !== null,
        DEVICE_TYPE_CARD_EXEMPTIONS,
      ),
    ).toEqual([])
  })

  it('gateway, heat pump and container have cards', () => {
    for (const type of [DeviceType.Gateway, DeviceType.HeatPump, DeviceType.Container])
      expect(connectedCardKindOf(type, null, RESOLVER_CAPS)).not.toBeNull()
  })
})
