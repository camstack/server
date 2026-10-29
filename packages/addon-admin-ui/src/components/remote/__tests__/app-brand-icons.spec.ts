import { describe, expect, it } from 'vitest'
import { APP_BRANDS, APP_ICON_PREFIX, appIconKey, resolveAppBrand } from '../app-brand-icons'

describe('app brand registry', () => {
  it('resolves an app: key to its brand', () => {
    const brand = resolveAppBrand('app:netflix')
    expect(brand?.label).toBe('Netflix')
    expect(brand?.mark.kind).toBe('glyph')
  })

  it('returns undefined for keys outside the registry so the caller falls back', () => {
    expect(resolveAppBrand('tv')).toBeUndefined()
    expect(resolveAppBrand('app:nope')).toBeUndefined()
    expect(resolveAppBrand(undefined)).toBeUndefined()
  })

  it('covers the requested services, with a lettermark where simple-icons has none', () => {
    const wanted = [
      'netflix',
      'youtube',
      'primevideo',
      'disneyplus',
      'spotify',
      'plex',
      'appletv',
      'dazn',
      'raiplay',
      'mediasetinfinity',
      'now',
      'twitch',
    ]
    for (const key of wanted) expect(resolveAppBrand(appIconKey(key)), key).toBeDefined()
    expect(resolveAppBrand('app:primevideo')?.mark.kind).toBe('lettermark')
  })

  it('has unique keys that fit the layout icon field and drawable marks', () => {
    const keys = APP_BRANDS.map((b) => b.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const brand of APP_BRANDS) {
      expect(`${APP_ICON_PREFIX}${brand.key}`.length).toBeLessThanOrEqual(60)
      if (brand.mark.kind === 'glyph') expect(brand.mark.path).toMatch(/^[Mm]/)
      else expect(brand.mark.text.length).toBeGreaterThan(0)
    }
  })
})
