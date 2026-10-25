import { describe, expect, it } from 'vitest'
import { mergeEmitAlert } from '../emit-alert-policy.js'

const baseAlert = {
  id: 'google-broker:google_001',
  category: 'google.broker-reconnect',
  severity: 'critical' as const,
  title: 'Google needs a new sign-in',
  message: 'Work Google needs sign-in again',
  status: 'active' as const,
  read: false,
  createdAt: 1,
  updatedAt: 2,
  metadata: { episodeKey: 'reconnect' },
}

describe('mergeEmitAlert', () => {
  it('stores a new alert as emitted', () => {
    expect(mergeEmitAlert({ existing: null, incoming: baseAlert })).toEqual(baseAlert)
  })

  it('preserves read when the same episode is re-emitted after markRead', () => {
    const merged = mergeEmitAlert({
      existing: { read: true, episodeKey: 'reconnect', status: 'active' },
      incoming: { ...baseAlert, read: false },
    })
    expect(merged.read).toBe(true)
  })

  it('opens a new episode when the prior alert was completed', () => {
    const merged = mergeEmitAlert({
      existing: { read: true, episodeKey: 'reconnect', status: 'completed' },
      incoming: { ...baseAlert, read: false },
    })
    expect(merged.read).toBe(false)
    expect(merged.status).toBe('active')
  })

  it('unreads the alert when the emitter marks a new episode', () => {
    const merged = mergeEmitAlert({
      existing: { read: true, episodeKey: 'reconnect' },
      incoming: {
        ...baseAlert,
        read: false,
        metadata: { episodeKey: 'reconnect-2' },
      },
    })
    expect(merged.read).toBe(false)
  })
})
