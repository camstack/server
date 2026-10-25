import { describe, expect, it } from 'vitest'
import { collectPackageZoneIds, isDelivererInPackageZone } from '../package-zone-activity.js'

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
