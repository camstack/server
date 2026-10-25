import { describe, it, expect } from 'vitest'

import { overlayDeclaration } from '../addon-row-manifest.js'

/**
 * Regression: after the HA broker rework, redeploying provider-homeassistant
 * (broker + device-adoption) left the integration picker without Home
 * Assistant. `loadNewAddons` refreshed `entry.declaration` to the new caps but
 * `listAddons` built its row manifest from the STALE `entry.addon.manifest`
 * (still [broker, ha-discovery]), so `getAvailableTypes` filtered HA out.
 */
interface TestManifest {
  id: string
  name: string
  icon?: string
  brokerKind?: string
  capabilities?: ReadonlyArray<{ name: string }>
}

describe('overlayDeclaration — listAddons row manifest freshness', () => {
  const base = { id: 'provider-homeassistant', name: 'Home Assistant' }

  it('prefers the fresh declaration capabilities over the stale instance manifest', () => {
    const instanceManifest: TestManifest = {
      ...base,
      capabilities: [{ name: 'broker' }, { name: 'ha-discovery' }],
    }
    const declaration: Partial<TestManifest> = {
      capabilities: [{ name: 'broker' }, { name: 'device-adoption' }],
      brokerKind: 'home-assistant',
    }

    const merged = overlayDeclaration(instanceManifest, declaration)

    expect(merged.capabilities).toEqual([{ name: 'broker' }, { name: 'device-adoption' }])
    expect(merged.brokerKind).toBe('home-assistant')
  })

  it('keeps the instance manifest when no fresh declaration exists', () => {
    const instanceManifest: TestManifest = { ...base, capabilities: [{ name: 'broker' }] }

    const merged = overlayDeclaration(instanceManifest, undefined)

    expect(merged.capabilities).toEqual([{ name: 'broker' }])
  })

  it('fills gaps from the instance manifest for keys the declaration omits', () => {
    const instanceManifest: TestManifest = {
      ...base,
      icon: 'assets/icon.svg',
      capabilities: [{ name: 'broker' }],
    }
    const declaration: Partial<TestManifest> = {
      capabilities: [{ name: 'broker' }, { name: 'device-adoption' }],
    }

    const merged = overlayDeclaration(instanceManifest, declaration)

    expect(merged.icon).toBe('assets/icon.svg')
    expect(merged.capabilities).toContainEqual({ name: 'device-adoption' })
  })
})
