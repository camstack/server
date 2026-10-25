import { describe, it, expect } from 'vitest'
import { deriveIntegrationDomain } from '../ha-integration-domain.js'

describe('deriveIntegrationDomain', () => {
  it('returns the dominant real platform, excluding noise platforms', () => {
    // The Dreame robot: its vacuum + sensor entities are `dreame_vacuum`;
    // a UniFi presence tracker rides along as noise → real platform wins.
    expect(deriveIntegrationDomain(['dreame_vacuum', 'dreame_vacuum', 'unifi'])).toBe(
      'dreame_vacuum',
    )
  })

  it('picks the most common real platform on ties of presence', () => {
    expect(deriveIntegrationDomain(['hue', 'hue', 'hacs'])).toBe('hue')
  })

  it('breaks count ties by first appearance', () => {
    expect(deriveIntegrationDomain(['zha', 'mqtt'])).toBe('zha')
  })

  it('falls back to the first platform when every platform is noise', () => {
    expect(deriveIntegrationDomain(['unifi', 'hacs', 'hassio'])).toBe('unifi')
  })

  it('treats the companion app (mobile_app) as noise', () => {
    // The companion app attaches presence trackers to many devices; it is
    // never the device's real integration.
    expect(deriveIntegrationDomain(['dreame_vacuum', 'mobile_app'])).toBe('dreame_vacuum')
  })

  it('returns null when there are no entities / platforms', () => {
    expect(deriveIntegrationDomain([])).toBeNull()
  })

  it('returns null when all platforms are null', () => {
    expect(deriveIntegrationDomain([null, null])).toBeNull()
  })

  it('ignores null platforms among real ones', () => {
    expect(deriveIntegrationDomain([null, 'dreame_vacuum', null])).toBe('dreame_vacuum')
  })
})
