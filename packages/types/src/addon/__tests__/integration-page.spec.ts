import { describe, expect, it } from 'vitest'
import { integrationPageHref } from '../integration-page.js'
import { buildSessionLostAlert } from '../session-health.js'

describe('integrationPageHref — the admin integration page of one instance', () => {
  it('names the providing addon in the path and the instance in ?instance=', () => {
    expect(integrationPageHref('bosch-homecom', 'int_0040')).toBe(
      '/integrations/bosch-homecom?instance=int_0040',
    )
  })

  it('without an instance it is the addon page', () => {
    expect(integrationPageHref('bosch-homecom')).toBe('/integrations/bosch-homecom')
    expect(integrationPageHref('bosch-homecom', '')).toBe('/integrations/bosch-homecom')
  })

  it('encodes both parts', () => {
    expect(integrationPageHref('a b', 'i/1')).toBe('/integrations/a%20b?instance=i%2F1')
  })
})

describe('buildSessionLostAlert — default action', () => {
  const base = {
    kind: 'petkit',
    providerName: 'PetKit',
    integrationId: 'int-1',
    integrationName: 'Home',
    reason: 'kicked',
  } as const

  it('opens the instance on its addon page when the addon is named', () => {
    expect(buildSessionLostAlert({ ...base, addonId: 'provider-petkit' }).action).toEqual({
      label: 'Open integration',
      href: '/integrations/provider-petkit?instance=int-1',
    })
  })

  it('never addresses the instance id as an addon id; without the addon it opens the list', () => {
    expect(buildSessionLostAlert(base).action).toEqual({
      label: 'Open integration',
      href: '/integrations',
    })
  })

  it('takes the severity it is given', () => {
    expect(buildSessionLostAlert({ ...base, severity: 'critical' }).severity).toBe('critical')
  })
})
