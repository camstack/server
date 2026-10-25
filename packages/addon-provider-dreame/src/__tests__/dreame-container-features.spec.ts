import { describe, it, expect } from 'vitest'
import { DeviceFeature } from '@camstack/types'
import {
  deriveContainerFeatures,
  mowerSupportsMap,
  mowerSupportsTargetedMowing,
  vacuumSupportsAi,
  vacuumSupportsCamera,
  vacuumSupportsMap,
  type DreameMowerCapabilitySnapshot,
  type DreameVacuumCapabilitySnapshot,
} from '../devices/dreame-container-features.js'

const vacuumCaps = (
  over: Partial<DreameVacuumCapabilitySnapshot> = {},
): DreameVacuumCapabilitySnapshot => ({
  canMap: true,
  hasCamera: false,
  hasAiObstacleDetection: true,
  aiFeatureCount: 3,
  ...over,
})

const mowerCaps = (
  over: Partial<DreameMowerCapabilitySnapshot> = {},
): DreameMowerCapabilitySnapshot => ({
  canMap: true,
  canMowAllArea: true,
  canMowZones: false,
  canMowEdges: false,
  canMowSpots: false,
  ...over,
})

describe('dreame container feature predicates — confirmed-capability (non-optimistic)', () => {
  it('vacuumSupportsMap is false when the handle is null (NOT optimistic true)', () => {
    expect(vacuumSupportsMap(null)).toBe(false)
  })

  it('vacuumSupportsCamera reflects the resolved hasCamera flag (null → false)', () => {
    expect(vacuumSupportsCamera(vacuumCaps({ hasCamera: true }))).toBe(true)
    expect(vacuumSupportsCamera(vacuumCaps({ hasCamera: false }))).toBe(false)
    expect(vacuumSupportsCamera(null)).toBe(false)
  })

  it('vacuumSupportsMap reflects the resolved canMap flag', () => {
    expect(vacuumSupportsMap(vacuumCaps({ canMap: true }))).toBe(true)
    expect(vacuumSupportsMap(vacuumCaps({ canMap: false }))).toBe(false)
  })

  it('vacuumSupportsAi is false when the handle is null', () => {
    expect(vacuumSupportsAi(null)).toBe(false)
  })

  it('vacuumSupportsAi requires both the flag AND at least one exposed toggle', () => {
    expect(vacuumSupportsAi(vacuumCaps({ hasAiObstacleDetection: true, aiFeatureCount: 3 }))).toBe(
      true,
    )
    // flag present but no individual toggles → no AI-switch children → no feature.
    expect(vacuumSupportsAi(vacuumCaps({ hasAiObstacleDetection: true, aiFeatureCount: 0 }))).toBe(
      false,
    )
    expect(vacuumSupportsAi(vacuumCaps({ hasAiObstacleDetection: false, aiFeatureCount: 3 }))).toBe(
      false,
    )
  })

  it('mowerSupportsMap is false when the handle is null (NOT optimistic true)', () => {
    expect(mowerSupportsMap(null)).toBe(false)
    expect(mowerSupportsMap(mowerCaps({ canMap: true }))).toBe(true)
    expect(mowerSupportsMap(mowerCaps({ canMap: false }))).toBe(false)
  })

  it('mowerSupportsTargetedMowing is false when the handle is null (NOT optimistic true)', () => {
    expect(mowerSupportsTargetedMowing(null)).toBe(false)
  })

  it('mowerSupportsTargetedMowing is the OR of the four mow modes', () => {
    const none = mowerCaps({
      canMowAllArea: false,
      canMowZones: false,
      canMowEdges: false,
      canMowSpots: false,
    })
    expect(mowerSupportsTargetedMowing(none)).toBe(false)
    expect(mowerSupportsTargetedMowing(mowerCaps({ ...none, canMowZones: true }))).toBe(true)
    expect(mowerSupportsTargetedMowing(mowerCaps({ ...none, canMowEdges: true }))).toBe(true)
    expect(mowerSupportsTargetedMowing(mowerCaps({ ...none, canMowSpots: true }))).toBe(true)
    expect(mowerSupportsTargetedMowing(mowerCaps({ ...none, canMowAllArea: true }))).toBe(true)
  })
})

describe('deriveContainerFeatures', () => {
  it('always includes Resyncable', () => {
    expect(
      deriveContainerFeatures({ kind: 'unsupported', vacuumCaps: null, mowerCaps: null }),
    ).toEqual([DeviceFeature.Resyncable])
  })

  it('vacuum with map + AI advertises VacuumHasMap + VacuumHasAi', () => {
    const features = deriveContainerFeatures({
      kind: 'vacuum',
      vacuumCaps: vacuumCaps({ canMap: true, hasAiObstacleDetection: true, aiFeatureCount: 2 }),
      mowerCaps: null,
    })
    expect(features).toContain(DeviceFeature.Resyncable)
    expect(features).toContain(DeviceFeature.VacuumHasMap)
    expect(features).toContain(DeviceFeature.VacuumHasAi)
    expect(features).not.toContain(DeviceFeature.MowerHasMap)
  })

  it('vacuum without map and without AI advertises only Resyncable', () => {
    const features = deriveContainerFeatures({
      kind: 'vacuum',
      vacuumCaps: vacuumCaps({ canMap: false, hasAiObstacleDetection: false, aiFeatureCount: 0 }),
      mowerCaps: null,
    })
    expect(features).toEqual([DeviceFeature.Resyncable])
  })

  it('vacuum with an unresolved handle advertises only Resyncable (no optimistic flags)', () => {
    const features = deriveContainerFeatures({ kind: 'vacuum', vacuumCaps: null, mowerCaps: null })
    expect(features).toEqual([DeviceFeature.Resyncable])
  })

  it('mower with map + targeted mowing advertises MowerHasMap + MowerHasTargetedMowing', () => {
    const features = deriveContainerFeatures({
      kind: 'mower',
      vacuumCaps: null,
      mowerCaps: mowerCaps({ canMap: true, canMowAllArea: true }),
    })
    expect(features).toContain(DeviceFeature.MowerHasMap)
    expect(features).toContain(DeviceFeature.MowerHasTargetedMowing)
    expect(features).not.toContain(DeviceFeature.VacuumHasMap)
  })

  it('mower with an unresolved handle advertises only Resyncable (no optimistic flags)', () => {
    const features = deriveContainerFeatures({ kind: 'mower', vacuumCaps: null, mowerCaps: null })
    expect(features).toEqual([DeviceFeature.Resyncable])
  })
})
