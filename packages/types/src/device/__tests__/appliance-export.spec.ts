/**
 * A plug-built washer, dryer or dishwasher leaves CamStack only where the
 * other ecosystem can say what it is. Home Assistant receives the power
 * sensor. The rest name why they do not.
 */
import { describe, expect, it } from 'vitest'
import { APPLIANCE_EXPORT, applianceExport, PLUG_APPLIANCE_TYPES } from '../appliance-export.js'
import { DeviceType } from '../device-type.js'

describe('appliance export', () => {
  it('offers each appliance to Home Assistant as its power reading', () => {
    for (const type of PLUG_APPLIANCE_TYPES) {
      const decision = applianceExport('ha', type)
      expect(decision?.exported).toBe(true)
      if (decision === null || !decision.exported) return
      expect(decision.as).toContain('power sensor')
    }
  })

  it.each([
    'homekit',
    'alexa',
    'google',
    'matter',
  ] as const)('does not export an appliance to %s, and says why', (ecosystem) => {
    for (const type of PLUG_APPLIANCE_TYPES) {
      const decision = APPLIANCE_EXPORT[ecosystem][type]
      expect(decision.exported).toBe(false)
      if (decision.exported) return
      expect(decision.reason.length).toBeGreaterThan(0)
    }
  })

  it('says nothing about a light', () => {
    expect(applianceExport('ha', DeviceType.Light)).toBeNull()
  })
})
