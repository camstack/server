import { describe, it, expect } from 'vitest'
import { pickFactoryKey, DEFAULT_DEVICE_KEY } from '../factory-key.js'

describe('pickFactoryKey', () => {
  it('returns the deviceKey when provided', () => {
    expect(pickFactoryKey('edgetpu:usb')).toBe('edgetpu:usb')
    expect(pickFactoryKey('openvino:gpu')).toBe('openvino:gpu')
  })

  it('returns the default sentinel when omitted or empty', () => {
    expect(pickFactoryKey(undefined)).toBe(DEFAULT_DEVICE_KEY)
    expect(pickFactoryKey('')).toBe(DEFAULT_DEVICE_KEY)
  })
})
