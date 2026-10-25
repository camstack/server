import { describe, it, expect } from 'vitest'
import { brokerCapability } from '../capabilities/broker.cap.js'

describe('broker cap — settings-schema + pre-creation test methods', () => {
  it('declares getSettingsSchema keyed by kind', () => {
    const m = brokerCapability.methods.getSettingsSchema
    expect(m).toBeDefined()
    expect(m.input.parse({ kind: 'home-assistant' })).toEqual({ kind: 'home-assistant' })
  })

  it('declares testSettings taking kind + settings, returning ok/error', () => {
    const m = brokerCapability.methods.testSettings
    expect(m).toBeDefined()
    expect(m.input.parse({ kind: 'home-assistant', settings: { baseUrl: 'x' } })).toEqual({
      kind: 'home-assistant',
      settings: { baseUrl: 'x' },
    })
    expect(m.output.parse({ ok: true })).toEqual({ ok: true })
    expect(m.output.parse({ ok: false, error: 'nope' })).toEqual({ ok: false, error: 'nope' })
    expect(() => m.output.parse({ ok: false })).toThrow() // error required on failure
    expect(() => m.output.parse({ ok: true, error: 'x' })).toThrow() // no error field on success
  })
})
