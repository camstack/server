/**
 * R14 (D690): a rule's zones are offered in BOTH modes of its zone field —
 * included and excluded — each named "camera:zone", from every camera the rule
 * can see, not only from an "Only these" device list.
 */
import { describe, expect, it } from 'vitest'
import { ruleScopeDraftOf } from '../rule-scope-model'
import { zoneCameraIds, zonePickerItems } from '../zone-scope-items'

const CAMERAS = [
  { id: 1, name: 'Front door' },
  { id: 2, name: 'Garden' },
  { id: 3, name: 'Box' },
]

describe('zoneCameraIds', () => {
  it('a rule on every device lists the zones of every camera', () => {
    expect(zoneCameraIds(ruleScopeDraftOf<number>(undefined, undefined), CAMERAS)).toEqual([
      1, 2, 3,
    ])
  })

  it('"Only these" lists the zones of the chosen cameras — never of a sensor', () => {
    expect(zoneCameraIds(ruleScopeDraftOf<number>([2, 99], undefined), CAMERAS)).toEqual([2])
  })

  it('"All except these" lists the zones of every camera it still covers', () => {
    expect(zoneCameraIds(ruleScopeDraftOf<number>(undefined, [1]), CAMERAS)).toEqual([2, 3])
  })
})

describe('zonePickerItems', () => {
  it('names each zone "camera:zone" and groups it under its camera', () => {
    expect(
      zonePickerItems([
        { value: 'z1', label: 'Uscio', hint: 'Front door' },
        { value: 'z2', label: 'Aiuola' },
      ]),
    ).toEqual([
      { id: 'z1', name: 'Front door:Uscio', type: 'Front door' },
      { id: 'z2', name: 'Aiuola' },
    ])
  })
})
