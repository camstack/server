import { describe, it, expect } from 'vitest'
import { buttonCapability } from '../button.cap.js'
import { DeviceType } from '../../device/device-type.js'

describe('buttonCapability shape', () => {
  it('has name "button"', () => {
    expect(buttonCapability.name).toBe('button')
  })

  it('has scope "device"', () => {
    expect(buttonCapability.scope).toBe('device')
  })

  it('has deviceNative: true', () => {
    expect(buttonCapability.deviceNative).toBe(true)
  })

  it('has mode "singleton"', () => {
    expect(buttonCapability.mode).toBe('singleton')
  })

  it('includes DeviceType.Button in deviceTypes', () => {
    expect(buttonCapability.deviceTypes).toContain(DeviceType.Button)
  })

  it('has a "press" method', () => {
    expect(typeof buttonCapability.methods.press).toBe('object')
  })

  it('press method is a mutation', () => {
    expect(buttonCapability.methods.press.kind).toBe('mutation')
  })

  it('press method requires protected auth', () => {
    expect(buttonCapability.methods.press.auth).toBe('protected')
  })

  it('has no status field (fire-only)', () => {
    expect((buttonCapability as Record<string, unknown>)['status']).toBeUndefined()
  })

  it('has no runtimeState field (fire-only)', () => {
    expect((buttonCapability as Record<string, unknown>)['runtimeState']).toBeUndefined()
  })
})
