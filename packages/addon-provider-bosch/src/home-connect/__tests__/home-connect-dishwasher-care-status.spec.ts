import { describe, expect, it } from 'vitest'
import {
  dishwasherStatusFromFeatures,
  type HomeConnectView,
} from '../home-connect-domain-mapping.js'
import { careDescription, CARE_NAMES } from './dishwasher-care-fixture.js'

const NOW = 1_700_000_000_000

function status(features: Record<string, unknown>, overrides: Partial<HomeConnectView> = {}) {
  return dishwasherStatusFromFeatures({
    features: new Map(Object.entries(features)),
    description: careDescription(),
    link: 'connected',
    lastValueAt: NOW,
    ...overrides,
  })
}

describe('dishwasher status — filter and machine care', () => {
  it('reports nothing it was not told: every care field is null, never false / 0', () => {
    const s = status({})
    expect(s.filterCleaningDue).toBeNull()
    expect(s.machineCareDue).toBeNull()
    expect(s.machineCareRemainingRuns).toBeNull()
  })

  it('a raised filter-cleaning reminder is due, a raised machine-care reminder is due', () => {
    const s = status({
      [CARE_NAMES.smartFilter]: 'Present',
      [CARE_NAMES.machineCare]: 'Present',
      [CARE_NAMES.careRuns]: 3,
    })
    expect(s.filterCleaningDue).toBe(true)
    expect(s.machineCareDue).toBe(true)
    expect(s.machineCareRemainingRuns).toBe(3)
  })

  it('the combined reminder raises both, a cleared one reads false, not null', () => {
    const both = status({ [CARE_NAMES.machineCareAndFilter]: 'Present' })
    expect(both.filterCleaningDue).toBe(true)
    expect(both.machineCareDue).toBe(true)
    const cleared = status({
      [CARE_NAMES.smartFilter]: 'Off',
      [CARE_NAMES.checkFilter]: 'Off',
      [CARE_NAMES.machineCare]: 'Off',
    })
    expect(cleared.filterCleaningDue).toBe(false)
    expect(cleared.machineCareDue).toBe(false)
  })

  it('check-filter-system counts as a filter reminder; one raised among cleared ones wins', () => {
    const s = status({
      [CARE_NAMES.smartFilter]: 'Off',
      [CARE_NAMES.checkFilter]: 'Present',
    })
    expect(s.filterCleaningDue).toBe(true)
  })

  it('an unusable run counter stays null', () => {
    expect(status({ [CARE_NAMES.careRuns]: 'soon' }).machineCareRemainingRuns).toBeNull()
  })

  it('a dropped link makes them unknown even with stale values around', () => {
    const s = status({ [CARE_NAMES.machineCare]: 'Present' }, { link: 'disconnected' })
    expect(s.machineCareDue).toBeNull()
    expect(s.filterCleaningDue).toBeNull()
    expect(s.machineCareRemainingRuns).toBeNull()
  })
})
