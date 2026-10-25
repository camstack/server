import { describe, expect, it } from 'vitest'
import { calendarSourceCapability } from '../capabilities/calendar-source.cap.js'
import { CAP_PROVIDER_KIND_MAP, getCapsByProviderKind } from '../generated/provider-kind-map.js'

describe('calendar-source providerKind', () => {
  it('is tagged calendar so Connectivity can list sources', () => {
    expect(calendarSourceCapability.providerKind).toBe('calendar')
    expect(CAP_PROVIDER_KIND_MAP['calendar-source']).toBe('calendar')
    expect(getCapsByProviderKind('calendar')).toContain('calendar-source')
  })
})
