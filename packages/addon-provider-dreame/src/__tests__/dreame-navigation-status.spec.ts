import { describe, expect, it } from 'vitest'
import {
  decodeFollowing,
  decodeFillLight,
  decodeFillLightSet,
  decodeNavigationReadback,
} from '../devices/dreame-navigation-status.js'

describe('decodeFillLight (4/50)', () => {
  it('reads the packed fill-light JSON the robot reports', () => {
    expect(decodeFillLight('{"k":"FillinLight","v":1}')).toEqual({ flash: true })
    expect(decodeFillLight({ k: 'FillinLight', v: 0 })).toEqual({ flash: false })
  })

  it('decodes NOTHING for another key, a malformed string or an absent property', () => {
    expect(decodeFillLight('{"k":"Other","v":1}')).toEqual({})
    expect(decodeFillLight('not json')).toEqual({})
    expect(decodeFillLight(undefined)).toEqual({})
  })
})

describe('decodeFillLightSet (10001/9)', () => {
  it('101 is auto, 40..100 is a manual level', () => {
    expect(decodeFillLightSet('101')).toEqual({ lightMode: 'auto' })
    expect(decodeFillLightSet('70')).toEqual({ lightMode: 'manual', lightLevel: 70 })
    expect(decodeFillLightSet(40)).toEqual({ lightMode: 'manual', lightLevel: 40 })
  })

  it('an out-of-range or absent value decodes to nothing — the previous slice keeps its value', () => {
    expect(decodeFillLightSet('12')).toEqual({})
    expect(decodeFillLightSet(undefined)).toEqual({})
  })
})

describe('decodeNavigationReadback', () => {
  it('merges what the handle reports and leaves the rest untouched', () => {
    const props = new Map<string, unknown>([
      ['4/50', '{"k":"FillinLight","v":1}'],
      ['10001/9', '101'],
    ])
    expect(decodeNavigationReadback((siid, piid) => props.get(`${siid}/${piid}`))).toEqual({
      flash: true,
      lightMode: 'auto',
    })
    expect(decodeNavigationReadback(() => undefined)).toEqual({})
  })
})

describe('decodeFollowing — the follow flag is the robot state', () => {
  it('state 26 is following, any other known state is not, an unknown state says nothing', () => {
    expect(decodeFollowing(26)).toBe(true)
    expect(decodeFollowing(1)).toBe(false)
    expect(decodeFollowing(null)).toBeNull()
    expect(decodeFollowing(undefined)).toBeNull()
  })
})
