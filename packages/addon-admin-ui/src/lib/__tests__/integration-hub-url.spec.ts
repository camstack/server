/**
 * The integration hub's address: which integration (and section) a URL names,
 * and the ONE builder every link into an integration goes through.
 *
 * Three behaviours are pinned here because each is a link that would otherwise
 * be worse than none:
 *  - a URL that names an installed integration opens THAT one;
 *  - a URL that names something no longer installed falls back AND says so —
 *    but only once the list has answered (unknown is not "gone");
 *  - Connectivity's old `?tab=<kind>` links still land in the right group.
 */
import { describe, expect, it } from 'vitest'

import {
  INTEGRATION_HUB_PAGES,
  INTEGRATION_PARAM,
  SECTION_PARAM,
  addonCatalogHref,
  integrationHubHref,
  resolveIntegrationSelection,
  selectIntegrationParams,
} from '../integration-hub-url'

const IDS = ['export-alexa', 'export-hap', 'mqtt-broker'] as const
const GROUP_FIRST = { 'device-export': 'export-alexa', broker: 'mqtt-broker' }

describe('resolveIntegrationSelection', () => {
  it('opens the integration the URL names', () => {
    expect(
      resolveIntegrationSelection({
        ids: IDS,
        requested: 'export-hap',
        answered: true,
      }),
    ).toEqual({ selectedId: 'export-hap', staleId: null })
  })

  it('opens the first integration when the URL names none', () => {
    expect(resolveIntegrationSelection({ ids: IDS, requested: null, answered: true })).toEqual({
      selectedId: 'export-alexa',
      staleId: null,
    })
  })

  it('falls back to the first integration and reports a stale id once answered', () => {
    expect(
      resolveIntegrationSelection({ ids: IDS, requested: 'export-google', answered: true }),
    ).toEqual({ selectedId: 'export-alexa', staleId: 'export-google' })
  })

  it('never calls an id stale before the list has answered', () => {
    expect(
      resolveIntegrationSelection({ ids: [], requested: 'export-google', answered: false }),
    ).toEqual({ selectedId: null, staleId: null })
  })

  it('reports a stale id on an answered EMPTY list', () => {
    expect(
      resolveIntegrationSelection({ ids: [], requested: 'tailscale', answered: true }),
    ).toEqual({ selectedId: null, staleId: 'tailscale' })
  })

  it('maps a legacy group link (?tab=<kind>) onto that group’s first integration', () => {
    expect(
      resolveIntegrationSelection({
        ids: IDS,
        requested: null,
        answered: true,
        legacyGroup: 'broker',
        groupFirst: GROUP_FIRST,
      }),
    ).toEqual({ selectedId: 'mqtt-broker', staleId: null })
  })

  it('lets an explicit integration win over a legacy group', () => {
    expect(
      resolveIntegrationSelection({
        ids: IDS,
        requested: 'export-hap',
        answered: true,
        legacyGroup: 'broker',
        groupFirst: GROUP_FIRST,
      }).selectedId,
    ).toBe('export-hap')
  })

  it('ignores a legacy group with no integration in it', () => {
    expect(
      resolveIntegrationSelection({
        ids: IDS,
        requested: null,
        answered: true,
        legacyGroup: 'email',
        groupFirst: GROUP_FIRST,
      }),
    ).toEqual({ selectedId: 'export-alexa', staleId: null })
  })
})

describe('selectIntegrationParams', () => {
  it('sets the integration, drops the section and keeps every other param', () => {
    const next = selectIntegrationParams(
      new URLSearchParams('tab=remote-access&integration=a&section=settings&node=hub'),
      'b',
    )
    expect(next.get(INTEGRATION_PARAM)).toBe('b')
    expect(next.has(SECTION_PARAM)).toBe(false)
    expect(next.get('tab')).toBe('remote-access')
    expect(next.get('node')).toBe('hub')
  })

  it('drops the legacy group param it replaces', () => {
    const next = selectIntegrationParams(new URLSearchParams('tab=broker'), 'mqtt-broker', 'tab')
    expect(next.has('tab')).toBe(false)
    expect(next.get(INTEGRATION_PARAM)).toBe('mqtt-broker')
  })

  it('sets a section when asked for one', () => {
    const next = selectIntegrationParams(new URLSearchParams(), 'export-alexa', null, 'settings')
    expect(next.get(SECTION_PARAM)).toBe('settings')
  })
})

describe('integrationHubHref — the one builder for a link into an integration', () => {
  it('builds a bare page link', () => {
    expect(integrationHubHref('connectivity')).toBe('/system/integrations')
  })

  it('opens a Connectivity kind section when the link names one', () => {
    expect(
      integrationHubHref('connectivity', {
        integration: 'google-services',
        kindSection: 'brokers',
      }),
    ).toBe('/system/integrations?tab=brokers&integration=google-services')
  })

  it('never lets a kind section override a page’s own tab', () => {
    expect(integrationHubHref('turn', { kindSection: 'brokers' })).toBe('/system/network?tab=turn')
  })

  it('carries the page’s own tab for an integration page embedded under a tab strip', () => {
    expect(integrationHubHref('remoteAccess')).toBe('/system/network?tab=remote-access')
  })

  it('names the integration and the section', () => {
    expect(
      integrationHubHref('connectivity', { integration: 'export-alexa', section: 'settings' }),
    ).toBe('/system/integrations?integration=export-alexa&section=settings')
    expect(integrationHubHref('turn', { integration: 'cloudflare-turn' })).toBe(
      '/system/network?tab=turn&integration=cloudflare-turn',
    )
  })

  it('encodes ids', () => {
    expect(integrationHubHref('logging', { integration: 'a b&c' })).toBe(
      '/system/logs?tab=destinations&integration=a+b%26c',
    )
  })

  it('declares every page on a /system route', () => {
    for (const page of Object.values(INTEGRATION_HUB_PAGES)) {
      expect(page.path.startsWith('/system/')).toBe(true)
    }
  })
})

describe('addonCatalogHref', () => {
  it('links the Addons catalog filtered to a capability', () => {
    expect(addonCatalogHref('device-export')).toBe('/system/addons?capability=device-export')
  })
})
