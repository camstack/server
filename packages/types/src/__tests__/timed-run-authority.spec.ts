import { describe, expect, it } from 'vitest'
import { timedRunCapability } from '../capabilities/timed-run.cap'

describe('timed-run authority', () => {
  it('setSettings is the same authority as runFor: operating the device, not admin', () => {
    const { setSettings, runFor } = timedRunCapability.methods
    expect(setSettings.auth).toBe('protected')
    expect(setSettings.auth).toBe(runFor.auth)
  })

  it('has no derived settings form: the one-tap run is edited on the control', () => {
    expect('deviceConfig' in timedRunCapability).toBe(false)
  })
})
