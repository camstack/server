import { describe, expect, it } from 'vitest'
import { homeComFaultReading } from '../homecom-faults.js'
import { heatPumpReadingFrom } from '../homecom-heat-pump.js'
import { k40Reading } from './homecom-bridge-fixture.js'

describe('HomeCom gateway faults on the error cap', () => {
  it('an unread notification list is unknown, never "no fault"', () => {
    const slice = homeComFaultReading(null, 5)
    expect(slice.active).toBeNull()
    expect(slice.lastFetchedAt).toBe(5)
  })

  it('an answered empty list, or history only, is no fault', () => {
    expect(homeComFaultReading([], 5).active).toBe(false)
    const history = [{ code: 'A11-1010', active: false, severity: 'error' as const }]
    expect(homeComFaultReading(history, 5).active).toBe(false)
  })

  it('the principal fault is the first error, every active one is listed', () => {
    const slice = homeComFaultReading(
      [
        { code: 'H00-2', active: true, severity: 'warning' },
        { code: 'A11-1010', active: true, severity: 'error' },
        { code: 'B1-1', active: false, severity: 'error' },
      ],
      9,
    )
    expect(slice).toMatchObject({ active: true, code: 'A11-1010', severity: 'error' })
    expect(slice.faults?.map((f) => f.code)).toEqual(['H00-2', 'A11-1010'])
  })

  it('the heat pump reading carries the bridge faults through, null included', () => {
    const unread = { ...k40Reading(), faults: null }
    expect(heatPumpReadingFrom(unread).faults).toBeNull()
    const raised = {
      ...k40Reading(),
      faults: [{ code: 'X-1', active: true, severity: 'error' as const }],
    }
    expect(heatPumpReadingFrom(raised).faults).toEqual(raised.faults)
  })
})
