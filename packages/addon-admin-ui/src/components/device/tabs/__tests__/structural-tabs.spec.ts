import { describe, expect, it } from 'vitest'
import { structuralTabsFor } from '../structural-tabs'

describe('structural tabs — Customize (D676 ruling 1)', () => {
  it('an admin sees Customize on every device type, right after Config', () => {
    expect(structuralTabsFor('sensor', true, true).map((t) => t.id)).toEqual([
      'overview',
      'config',
      'customize',
      'history',
    ])
    expect(structuralTabsFor('camera', true, true).map((t) => t.id)).toEqual([
      'overview',
      'config',
      'customize',
      'history',
      'detection-pipeline',
      'bindings',
    ])
  })
  it('a non-admin never sees it — every coreBlocks method is admin', () => {
    expect(structuralTabsFor('pet-feeder', false, true).map((t) => t.id)).toEqual([
      'overview',
      'config',
      'history',
    ])
    expect(structuralTabsFor('camera', false, true).map((t) => t.id)).toEqual([
      'overview',
      'config',
      'history',
      'detection-pipeline',
      'bindings',
    ])
  })
})

describe('structural tabs — History (D899)', () => {
  it('every real device with recorded series has a History tab, for admins and viewers alike', () => {
    expect(structuralTabsFor('climate', false, true).map((t) => t.id)).toContain('history')
    expect(structuralTabsFor('dishwasher', true, true).map((t) => t.id)).toContain('history')
  })
  it('a container has none — device-history does not record it', () => {
    expect(structuralTabsFor('container', true, true).map((t) => t.id)).not.toContain('history')
  })
  it('a device with no recorded series has none — an empty tab is not offered', () => {
    expect(structuralTabsFor('gateway', true, false).map((t) => t.id)).not.toContain('history')
    expect(structuralTabsFor('sensor', false, false).map((t) => t.id)).toEqual([
      'overview',
      'config',
    ])
  })
})
