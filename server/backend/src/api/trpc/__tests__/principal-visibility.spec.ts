/**
 * Unit spec for non-admin principal device visibility (F0.4 minting + F0.5
 * event filtering). Exercises the pure module directly — the same value the
 * share-token router and the event routers consult.
 */
import type { TokenScope } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  callerCanViewDevice,
  filterViewableDeviceIds,
  isBroadEventViewer,
} from '../principal-visibility.js'

const deviceScope = (ids: number[]): TokenScope => ({
  type: 'device',
  selector: { kind: 'ids', ids },
  access: ['view'],
})
const categoryDeviceView: TokenScope = { type: 'category', target: 'device', access: ['view'] }
const categorySystemView: TokenScope = { type: 'category', target: 'system', access: ['view'] }
const capabilityView: TokenScope = { type: 'capability', target: 'logs', access: ['view'] }

describe('callerCanViewDevice', () => {
  it('a broad category:device view grant covers every device', () => {
    expect(callerCanViewDevice([categoryDeviceView], 101)).toBe(true)
    expect(callerCanViewDevice([categoryDeviceView], 999)).toBe(true)
  })

  it('a device:[…] grant covers only the named devices', () => {
    expect(callerCanViewDevice([deviceScope([5])], 5)).toBe(true)
    expect(callerCanViewDevice([deviceScope([5])], 7)).toBe(false)
  })

  it('device:[parent] covers a child accessory via the ancestor walk', () => {
    // 42 is a child of 5; a grant on 5 must reach 42 without re-listing it.
    // callerCanViewDevice probes VIEW access, which inherits by default.
    const lookup = {
      getAncestors: (id: number): readonly number[] => (id === 42 ? [5] : []),
      getType: () => null,
      getLocation: () => null,
    }
    expect(callerCanViewDevice([deviceScope([5])], 42, lookup)).toBe(true)
    expect(callerCanViewDevice([deviceScope([5])], 43, lookup)).toBe(false)
  })

  it('a category:system-only grant does NOT satisfy the device-view probe', () => {
    expect(callerCanViewDevice([categorySystemView], 101)).toBe(false)
  })

  it('an empty scope set can view nothing (fail closed)', () => {
    expect(callerCanViewDevice([], 101)).toBe(false)
  })
})

describe('filterViewableDeviceIds', () => {
  it('intersects the requested ids with what the caller can see', () => {
    expect(filterViewableDeviceIds([deviceScope([5])], [5, 7])).toEqual([5])
    expect(filterViewableDeviceIds([deviceScope([9])], [5, 7])).toEqual([])
    expect(filterViewableDeviceIds([categoryDeviceView], [5, 7])).toEqual([5, 7])
  })
})

describe('isBroadEventViewer', () => {
  it('any category-scope view grant is a broad viewer (sees the whole firehose)', () => {
    expect(isBroadEventViewer([categoryDeviceView])).toBe(true)
    expect(isBroadEventViewer([categorySystemView])).toBe(true)
  })

  it('a device: / capability: only token is NOT broad (stream gets filtered)', () => {
    expect(isBroadEventViewer([deviceScope([5])])).toBe(false)
    expect(isBroadEventViewer([capabilityView])).toBe(false)
    expect(isBroadEventViewer([])).toBe(false)
  })
})
