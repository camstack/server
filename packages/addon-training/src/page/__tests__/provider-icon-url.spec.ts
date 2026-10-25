import { describe, expect, it } from 'vitest'
import { providerIconUrl } from '../provider-icon-url.js'

describe('providerIconUrl', () => {
  it('maps iconAsset to the hub addon-assets path', () => {
    expect(providerIconUrl('training-modal', 'assets/training-modal/icon.svg')).toBe(
      '/api/addon-assets/training-modal/assets/training-modal/icon.svg',
    )
  })

  it('refuses empty or path-traversal assets', () => {
    expect(providerIconUrl('training-modal', '')).toBeNull()
    expect(providerIconUrl('training-modal', '../secret')).toBeNull()
  })
})
