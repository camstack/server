import { describe, expect, it } from 'vitest'
import { providerLabelsOf } from '../device-provider-label'

describe('providerLabelsOf', () => {
  const addons = [
    { id: 'provider-homeassistant', name: 'Home Assistant' },
    { id: 'provider-reolink', name: 'Reolink' },
  ]

  it('names the provider by its addon alone, never the integration instance', () => {
    const labels = providerLabelsOf(
      [
        { id: 1, addonId: 'provider-homeassistant' },
        { id: 2, addonId: 'provider-reolink' },
      ],
      addons,
    )
    expect(labels.get(1)).toBe('Home Assistant')
    expect(labels.get(2)).toBe('Reolink')
  })

  it('leaves a device with an unknown addon out instead of guessing', () => {
    const labels = providerLabelsOf([{ id: 9, addonId: 'unknown' }], addons)
    expect(labels.has(9)).toBe(false)
  })
})
