import { describe, expect, it } from 'vitest'
import { formatProviderLabel, providerLabelsOf } from '../device-provider-label'

describe('formatProviderLabel', () => {
  it('names the addon and the integration instance', () => {
    expect(formatProviderLabel('Home Assistant', 'Casa')).toBe('Home Assistant (Casa)')
  })

  it('is just the addon without an instance', () => {
    expect(formatProviderLabel('Reolink', null)).toBe('Reolink')
    expect(formatProviderLabel('Reolink', undefined)).toBe('Reolink')
    expect(formatProviderLabel('Reolink', '  ')).toBe('Reolink')
  })

  it('does not repeat an instance named like its addon', () => {
    expect(formatProviderLabel('Reolink', 'Reolink')).toBe('Reolink')
  })
})

describe('providerLabelsOf', () => {
  const addons = [
    { id: 'provider-homeassistant', name: 'Home Assistant' },
    { id: 'provider-reolink', name: 'Reolink' },
  ]
  const integrations = [{ id: 'int-1', name: 'Casa' }]

  it('joins the fleet to the addon name and the instance name', () => {
    const labels = providerLabelsOf(
      [
        { id: 1, addonId: 'provider-homeassistant', integrationId: 'int-1' },
        { id: 2, addonId: 'provider-reolink' },
        { id: 3, addonId: 'provider-homeassistant', integrationId: 'gone' },
      ],
      addons,
      integrations,
    )
    expect(labels.get(1)).toBe('Home Assistant (Casa)')
    expect(labels.get(2)).toBe('Reolink')
    expect(labels.get(3)).toBe('Home Assistant')
  })

  it('leaves a device with an unknown addon out instead of guessing', () => {
    const labels = providerLabelsOf([{ id: 9, addonId: 'unknown' }], addons, integrations)
    expect(labels.has(9)).toBe(false)
  })
})
