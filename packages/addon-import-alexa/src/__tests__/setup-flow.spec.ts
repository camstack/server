import { describe, expect, it } from 'vitest'
import { reduceSetup } from '../speak/setup-flow.js'

describe('reduceSetup', () => {
  it('walks sign-in, a code, then the device list', () => {
    expect(reduceSetup('sign-in', { type: 'login', status: 'otp_needed' })).toBe('otp')
    expect(reduceSetup('otp', { type: 'otp', status: 'ok' })).toBe('devices')
    expect(reduceSetup('sign-in', { type: 'login', status: 'captcha' })).toBe('captcha')
    expect(reduceSetup('otp', { type: 'otp', status: 'failed' })).toBe('otp')
    expect(reduceSetup('devices', { type: 'reset' })).toBe('sign-in')
  })
})
