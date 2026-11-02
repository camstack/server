import { describe, expect, it } from 'vitest'
import {
  collectPackageZoneIds,
  delivererMotionNearPackageZone,
  isDelivererInPackageZone,
} from '../package-zone-activity.js'

describe('isDelivererInPackageZone', () => {
  const dropOff = new Set(['uscio'])

  it('is true only when a track zone is a configured package drop-off', () => {
    expect(isDelivererInPackageZone(['uscio'], dropOff)).toBe(true)
    expect(isDelivererInPackageZone(['aiuola', 'uscio'], dropOff)).toBe(true)
  })

  it('rejects motion in a different zone, or with no package zones configured', () => {
    expect(isDelivererInPackageZone(['aiuola'], dropOff)).toBe(false)
    expect(isDelivererInPackageZone(['uscio'], new Set())).toBe(false)
    expect(isDelivererInPackageZone([], dropOff)).toBe(false)
  })
})

describe('collectPackageZoneIds', () => {
  it('unions zone ids from enabled package-stage rules', () => {
    expect(
      collectPackageZoneIds([{ zoneIds: ['uscio'], enabled: true }, { zoneIds: ['portico'] }]),
    ).toEqual(new Set(['uscio', 'portico']))
  })

  it('skips a disabled rule', () => {
    expect(
      collectPackageZoneIds([
        { zoneIds: ['uscio'], enabled: false },
        { zoneIds: ['portico'], enabled: true },
      ]),
    ).toEqual(new Set(['portico']))
  })
})

describe('delivererMotionNearPackageZone', () => {
  // Doormat in the lower third of a 640x360 frame, normalised.
  const zoneRect = { x: 0.2, y: 0.5, w: 0.4, h: 0.2 }
  const base = { frameWidth: 640, frameHeight: 360, zoneRect }
  const region = (x: number, y: number, w: number, h: number) => ({ bbox: { x, y, w, h } })

  it('a region in the dilated apron next to the mat is true', () => {
    // Left of the mat (mat starts at x=128): inside the 0.5 apron.
    expect(delivererMotionNearPackageZone({ ...base, regions: [region(60, 190, 30, 60)] })).toBe(
      true,
    )
  })

  it('a region far from the mat is false', () => {
    expect(delivererMotionNearPackageZone({ ...base, regions: [region(600, 5, 30, 30)] })).toBe(
      false,
    )
  })

  it('a region covering nearly the whole frame is weather, not a courier', () => {
    expect(delivererMotionNearPackageZone({ ...base, regions: [region(0, 0, 640, 340)] })).toBe(
      false,
    )
  })

  it('no zone rect is false: unknown geometry never witnesses a delivery', () => {
    expect(
      delivererMotionNearPackageZone({
        ...base,
        zoneRect: null,
        regions: [region(60, 190, 30, 60)],
      }),
    ).toBe(false)
  })

  it('zero frame dimensions are false', () => {
    expect(
      delivererMotionNearPackageZone({
        ...base,
        frameWidth: 0,
        regions: [region(60, 190, 30, 60)],
      }),
    ).toBe(false)
  })
})
