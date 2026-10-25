import { describe, expect, it } from 'vitest'
import { structuralTabsFor } from '../structural-tabs'

describe('structural tabs — Customize (D676 ruling 1)', () => {
  it('an admin sees Customize on every device type, right after Config', () => {
    expect(structuralTabsFor('sensor', true).map((t) => t.id)).toEqual([
      'overview',
      'config',
      'customize',
      'history',
    ])
    expect(structuralTabsFor('camera', true).map((t) => t.id)).toEqual([
      'overview',
      'config',
      'customize',
      'history',
      'detection-pipeline',
      'bindings',
    ])
  })
  it('a non-admin never sees it — every coreBlocks method is admin', () => {
    expect(structuralTabsFor('pet-feeder', false).map((t) => t.id)).toEqual([
      'overview',
      'config',
      'history',
    ])
    expect(structuralTabsFor('camera', false).map((t) => t.id)).toEqual([
      'overview',
      'config',
      'history',
      'detection-pipeline',
      'bindings',
    ])
  })
})

describe('structural tabs — History (D899)', () => {
  it('every real device has a History tab, for admins and viewers alike', () => {
    expect(structuralTabsFor('climate', false).map((t) => t.id)).toContain('history')
    expect(structuralTabsFor('dishwasher', true).map((t) => t.id)).toContain('history')
  })
  it('a hub or a container has none — device-history records neither', () => {
    expect(structuralTabsFor('hub', true).map((t) => t.id)).not.toContain('history')
    expect(structuralTabsFor('container', true).map((t) => t.id)).not.toContain('history')
  })
})
