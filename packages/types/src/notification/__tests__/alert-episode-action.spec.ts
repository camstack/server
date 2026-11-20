import { describe, expect, it } from 'vitest'
import type { Alert } from '../../capabilities/alerts.cap.js'
import { alertEpisodePayload, parseAlertEpisodePayload } from '../alert-episode.js'

const alert: Alert = {
  id: 'google:broker:b1',
  category: 'google.broker',
  severity: 'critical',
  title: 'Google sign-in expired',
  message: 'Sign in again',
  status: 'active',
  read: false,
  createdAt: 1,
  updatedAt: 1,
  source: { type: 'addon', id: 'google-services' },
  action: {
    label: 'Sign in again',
    href: '/addon/google-services/oauth/start?brokerId=b1',
    navigation: 'server',
    invoke: { addonId: 'google-services', action: 'reconnect', input: { brokerId: 'b1' } },
  },
}

describe('an alert episode carries the alert action whole', () => {
  it('a raised episode keeps label, href, navigation and invoke, and actionUrl', () => {
    const parsed = parseAlertEpisodePayload(alertEpisodePayload(alert, 'raised', 5))
    expect(parsed?.action).toEqual(alert.action)
    expect(parsed?.actionUrl).toBe(alert.action?.href)
  })

  it('a resolved episode carries no action', () => {
    expect(alertEpisodePayload(alert, 'resolved', 5).action).toBeUndefined()
  })
})
