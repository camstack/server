import { describe, it, expect } from 'vitest'
import { buildChildCapDescriptors } from '../../moleculer/child-cap-descriptors.js'

describe('buildChildCapDescriptors', () => {
  it('stamps every singleton descriptor with its owning addonId', () => {
    const out = buildChildCapDescriptors(
      [
        { addonId: 'cloudflare-tunnel', capabilities: ['network-access'] },
        { addonId: 'cloudflare-turn', capabilities: ['turn-provider'] },
      ],
      [],
    )
    expect(out).toEqual([
      { capName: 'network-access', mode: 'singleton', addonId: 'cloudflare-tunnel' },
      { capName: 'turn-provider', mode: 'singleton', addonId: 'cloudflare-turn' },
    ])
  })

  it('keeps the SAME cap from two co-located addons as two descriptors', () => {
    // Grouped runner: cloudflare-tunnel and tailscale-ingress both provide
    // `network-access`. Deduplicating by capName alone (the old behaviour)
    // dropped one provider — dedupe is per (addonId, capName).
    const out = buildChildCapDescriptors(
      [
        { addonId: 'cloudflare-tunnel', capabilities: ['network-access'] },
        { addonId: 'tailscale-ingress', capabilities: ['network-access'] },
      ],
      [],
    )
    expect(out).toHaveLength(2)
    expect(out.map((d) => d.addonId)).toEqual(['cloudflare-tunnel', 'tailscale-ingress'])
  })

  it('deduplicates a repeated (addonId, capName) pair', () => {
    const out = buildChildCapDescriptors(
      [
        { addonId: 'a', capabilities: ['cap-x', 'cap-x'] },
        { addonId: 'a', capabilities: ['cap-x'] },
      ],
      [],
    )
    expect(out).toHaveLength(1)
  })

  it('stamps device-scoped native-cap descriptors with the owning addonId', () => {
    const out = buildChildCapDescriptors(
      [],
      [{ capName: 'ptz', addonId: 'provider-reolink', deviceIds: [3, 9] }],
    )
    expect(out).toEqual([
      { capName: 'ptz', mode: 'collection', deviceId: 3, addonId: 'provider-reolink' },
      { capName: 'ptz', mode: 'collection', deviceId: 9, addonId: 'provider-reolink' },
    ])
  })
})
