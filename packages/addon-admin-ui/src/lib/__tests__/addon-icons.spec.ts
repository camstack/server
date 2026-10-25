/**
 * An addon icon URL is produced only from a DECLARED manifest icon.
 *
 * The bug this pins (2026-10-08): `ProviderIcon` prefixed `provider-` to every
 * id, so devices owned by `core-blocks`, `camera-grid`, `terminal` and
 * `pipeline-analytics` requested `/api/addon-assets/provider-core-blocks/…`
 * — addons that do not exist — and the console filled with 404s.
 */
import { describe, expect, it } from 'vitest'

import { buildAddonIconMap, isAddonIconAssetPath, resolveAddonIconPath } from '../addon-icons'

const LIST = [
  { manifest: { id: 'provider-reolink', icon: 'assets/icon.svg' } },
  { manifest: { id: 'terminal', icon: 'assets/icon.svg' } },
  { manifest: { id: 'core-blocks', icon: 'assets/core-blocks/icon.svg' } },
  { manifest: { id: 'keychain' } },
  {
    manifest: { id: 'auth-oidc', icon: 'assets/old.svg' },
    declaration: { icon: 'assets/oidc/icon.svg' },
  },
  { manifest: { id: 'glyph-only', icon: 'gauge' } },
  { manifest: { id: 'escape', icon: '../../etc/passwd.svg' } },
  null,
  { manifest: {} },
]

describe('buildAddonIconMap', () => {
  const icons = buildAddonIconMap(LIST)

  it('keeps only addons that declare an asset path', () => {
    expect([...icons.keys()].sort()).toEqual([
      'auth-oidc',
      'core-blocks',
      'provider-reolink',
      'terminal',
    ])
  })

  it('the resolved declaration wins over the raw manifest', () => {
    expect(icons.get('auth-oidc')).toBe('assets/oidc/icon.svg')
  })

  it('an undefined list (query still loading) is an empty map', () => {
    expect(buildAddonIconMap(undefined).size).toBe(0)
  })
})

describe('resolveAddonIconPath', () => {
  const icons = buildAddonIconMap(LIST)

  it('serves a builtin by its OWN id — never a guessed provider- prefix', () => {
    expect(resolveAddonIconPath(icons, 'core-blocks')).toBe(
      '/api/addon-assets/core-blocks/assets/core-blocks/icon.svg',
    )
    expect(resolveAddonIconPath(icons, 'terminal')).toBe(
      '/api/addon-assets/terminal/assets/icon.svg',
    )
  })

  it('a bare provider name resolves to its provider- addon when that addon is known', () => {
    expect(resolveAddonIconPath(icons, 'reolink')).toBe(
      '/api/addon-assets/provider-reolink/assets/icon.svg',
    )
  })

  it('no request for an addon without a declared icon, or an unknown one', () => {
    expect(resolveAddonIconPath(icons, 'keychain')).toBeNull()
    expect(resolveAddonIconPath(icons, 'camera-grid')).toBeNull()
    expect(resolveAddonIconPath(icons, 'provider-core-blocks')).toBeNull()
    expect(resolveAddonIconPath(icons, 'homeassistant')).toBeNull()
    expect(resolveAddonIconPath(icons, '')).toBeNull()
    expect(resolveAddonIconPath(icons, null)).toBeNull()
  })
})

describe('isAddonIconAssetPath', () => {
  it('accepts image paths and rejects glyph names and traversal', () => {
    expect(isAddonIconAssetPath('assets/icon.png')).toBe(true)
    expect(isAddonIconAssetPath('gauge')).toBe(false)
    expect(isAddonIconAssetPath('../x.svg')).toBe(false)
    expect(isAddonIconAssetPath(42)).toBe(false)
  })
})
