/**
 * The one forwarding predicate (D672) — shared by the bridge's emit gate and
 * the camera status, so the card cannot call a sensor healthy that the bridge
 * drops (final review M-2, M-3).
 */
import type { CameraSensorsStatus } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { notForwardedReason, withForwarding } from '../camera-sensors/forwarding.js'

const CONFIGURED: CameraSensorsStatus = {
  state: 'configured',
  sensors: [
    {
      addonId: 'provider-homeassistant',
      stableId: 'ha:pir',
      mode: 'in-addition',
      state: 'ready',
      deviceId: 3299,
      name: 'Motion',
      caps: ['motion'],
    },
  ],
}

describe('camera sensors forwarding (D672)', () => {
  it('forwards only while the ACTIVE config lists onboard', () => {
    expect(notForwardedReason(['onboard'])).toBeNull()
    expect(notForwardedReason(['analyzer', 'onboard'])).toBeNull()
    expect(notForwardedReason(['analyzer'])).toBe('onboard-not-listed')
    expect(notForwardedReason([])).toBe('onboard-not-listed')
    expect(notForwardedReason(null)).toBe('no-active-detection')
  })

  it('a configured status carries the verdict; a forwarding one is unchanged', () => {
    expect(withForwarding(CONFIGURED, ['onboard'])).toEqual(CONFIGURED)
    expect(withForwarding(CONFIGURED, ['analyzer'])).toEqual({
      ...CONFIGURED,
      notForwarded: 'onboard-not-listed',
    })
    expect(withForwarding(CONFIGURED, null)).toEqual({
      ...CONFIGURED,
      notForwarded: 'no-active-detection',
    })
  })

  it('keeps cameraMotion and notEnforced beside notForwarded (task 11 review L6, task 13)', () => {
    const decided: CameraSensorsStatus = {
      ...CONFIGURED,
      cameraMotion: 'never',
      notEnforced: 'provider-not-split',
    }
    expect(withForwarding(decided, ['analyzer'])).toEqual({
      ...decided,
      notForwarded: 'onboard-not-listed',
    })
  })

  it('never decorates a status that is not configured', () => {
    expect(withForwarding({ state: 'not-configured' }, null)).toEqual({ state: 'not-configured' })
    const unreadable: CameraSensorsStatus = { state: 'unreadable', reason: 'x' }
    expect(withForwarding(unreadable, null)).toEqual(unreadable)
  })
})
