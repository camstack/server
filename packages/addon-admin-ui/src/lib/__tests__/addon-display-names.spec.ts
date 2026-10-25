import { describe, it, expect } from 'vitest'
import { buildAddonDisplayNameMap } from '../addon-display-names'

describe('buildAddonDisplayNameMap', () => {
  it('prefers the ADDON-level name over the bundle-level packageDisplayName', () => {
    // A bundle (e.g. @camstack/addon-cloudflare) ships multiple addons that
    // share one packageDisplayName ("Cloudflare"). Per-addon provider rows
    // must be distinguishable — the addon name wins.
    const map = buildAddonDisplayNameMap([
      {
        manifest: {
          id: 'cloudflare-tunnel',
          name: 'Cloudflare Tunnel',
          packageDisplayName: 'Cloudflare',
        },
      },
      {
        manifest: {
          id: 'cloudflare-turn',
          name: 'Cloudflare TURN Relay',
          packageDisplayName: 'Cloudflare',
        },
      },
    ])
    expect(map.get('cloudflare-tunnel')).toBe('Cloudflare Tunnel')
    expect(map.get('cloudflare-turn')).toBe('Cloudflare TURN Relay')
  })

  it('falls back to packageDisplayName, then the id', () => {
    const map = buildAddonDisplayNameMap([
      { manifest: { id: 'a', packageDisplayName: 'Pkg A' } },
      { manifest: { id: 'b' } },
    ])
    expect(map.get('a')).toBe('Pkg A')
    expect(map.get('b')).toBe('b')
  })

  it('skips malformed rows without crashing', () => {
    const map = buildAddonDisplayNameMap([null, {}, { manifest: {} }, 42, 'nope'])
    expect(map.size).toBe(0)
  })
})
