import { applianceExport, PLUG_APPLIANCE_TYPES } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { SUPPORTED_DEVICE_KINDS } from '../supported-device-kinds.js'

describe('Home Assistant export kinds', () => {
  it('offers a washer, a dryer and a dishwasher', () => {
    for (const type of PLUG_APPLIANCE_TYPES) {
      expect(SUPPORTED_DEVICE_KINDS).toContain(type)
      expect(applianceExport('ha', type)?.exported).toBe(true)
    }
  })
})
