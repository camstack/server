import { describe, it, expect } from 'vitest'
import { DeviceType } from '@camstack/types'
import { mapHaEntityToCamStack } from '../ha-domain-mapping.js'

describe('ha-domain-mapping — button / input_button (Phase C4)', () => {
  it('button.* → DeviceType.Button, capabilities: [button]', () => {
    const m = mapHaEntityToCamStack({ domain: 'button', deviceClass: null, attributes: {} })
    expect(m).not.toBeNull()
    expect(m?.deviceType).toBe(DeviceType.Button)
    expect(m?.role).toBeNull()
    expect(m?.capabilities).toEqual(['button'])
  })

  it('input_button.* → DeviceType.Button, capabilities: [button]', () => {
    const m = mapHaEntityToCamStack({ domain: 'input_button', deviceClass: null, attributes: {} })
    expect(m).not.toBeNull()
    expect(m?.deviceType).toBe(DeviceType.Button)
    expect(m?.role).toBeNull()
    expect(m?.capabilities).toEqual(['button'])
  })
})
