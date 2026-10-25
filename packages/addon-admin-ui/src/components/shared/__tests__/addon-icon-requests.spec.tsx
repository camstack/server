/// <reference types="@testing-library/jest-dom" />
/**
 * The icon components request an asset ONLY when the addon declares one.
 * Every other entry draws its glyph with no `<img>` — so no 404.
 */
import { render } from '@testing-library/react'
import { Cctv } from 'lucide-react'
import { describe, expect, it } from 'vitest'

import { StaticAddonIconsProvider } from '../../../contexts/addon-icons-context'
import { AddonAssetIcon } from '../AddonAssetIcon'
import { ProviderIcon } from '../ProviderIcon'

const ICONS: ReadonlyMap<string, string> = new Map([
  ['provider-reolink', 'assets/icon.svg'],
  ['core-blocks', 'assets/core-blocks/icon.svg'],
])

function withIcons(ui: React.ReactElement, icons: ReadonlyMap<string, string> = ICONS) {
  return render(<StaticAddonIconsProvider icons={icons}>{ui}</StaticAddonIconsProvider>)
}

const imgSrcs = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('img')].map((i) => i.getAttribute('src') ?? '')

describe('ProviderIcon', () => {
  it('a system addon id is requested under its own id, never provider-<id>', () => {
    const { container } = withIcons(<ProviderIcon type="core-blocks" />)
    expect(imgSrcs(container)).toEqual([
      '/api/addon-assets/core-blocks/assets/core-blocks/icon.svg',
    ])
  })

  it('an addon with no declared icon draws the glyph and requests nothing', () => {
    for (const type of ['camera-grid', 'pipeline-analytics', 'terminal', 'homeassistant']) {
      const { container, unmount } = withIcons(<ProviderIcon type={type} />)
      expect(imgSrcs(container)).toEqual([])
      expect(container.querySelector('svg')).not.toBeNull()
      unmount()
    }
  })

  it('a bare provider name still finds its provider- addon', () => {
    const { container } = withIcons(<ProviderIcon type="reolink" />)
    expect(imgSrcs(container)).toEqual(['/api/addon-assets/provider-reolink/assets/icon.svg'])
  })

  it('outside the provider (no addon list) nothing is requested', () => {
    const { container } = render(<ProviderIcon type="provider-reolink" />)
    expect(imgSrcs(container)).toEqual([])
  })
})

describe('AddonAssetIcon', () => {
  it('requests the declared icon', () => {
    const { container } = withIcons(
      <AddonAssetIcon addonId="core-blocks" fallback={Cctv} tileClassName="" />,
    )
    expect(imgSrcs(container)).toEqual([
      '/api/addon-assets/core-blocks/assets/core-blocks/icon.svg',
    ])
  })

  it('draws the fallback glyph with no request when none is declared', () => {
    const { container } = withIcons(
      <AddonAssetIcon addonId="keychain" fallback={Cctv} tileClassName="" />,
    )
    expect(imgSrcs(container)).toEqual([])
    expect(container.querySelector('svg')).not.toBeNull()
  })
})
