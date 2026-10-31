import { describe, expect, it } from 'vitest'
import { RademacherProviderAddon } from '../addon.js'
import { buildConnectionFormSchema } from '../config.js'

/**
 * A HomePilot / Start2Smart hub answers the same unauthenticated requests any
 * HTTP server can answer, so a LAN scan cannot tell one from a router or a NAS
 * (a bare status code, and the library's generic name, matched 17 hosts). The hub is
 * added by host through the integration form instead.
 */
describe('Rademacher has no LAN discovery', () => {
  it('offers no scan modes and does not take part in the setup scan', async () => {
    const addon = new RademacherProviderAddon()
    expect(await addon.supportsDiscovery()).toBe(false)
    expect(await addon.getDiscoveryModes()).toEqual([])
    expect(await addon.classifyDiscoveryHits({ hits: [] })).toEqual([])
  })

  it('has no hub-picker field on the integration form', () => {
    const fields = buildConnectionFormSchema().sections.flatMap((section) => section.fields)
    expect(fields.map((field) => field.type)).not.toContain('addon-action-select')
    expect(fields.map((field) => field.key)).toContain('host')
  })
})
