import { describe, expect, it } from 'vitest'
import type { ProductEnvironment } from '../product/desktop-product'
import {
  PRODUCT_OVERRIDE_ENV_VAR,
  VIEWER_APP_NAME,
  VIEWER_PRODUCT_NAME,
  resolveDesktopProduct,
} from '../product/desktop-product'

function env(overrides: Partial<ProductEnvironment> = {}): ProductEnvironment {
  return { appName: '@camstack/desktop', isPackaged: true, override: undefined, ...overrides }
}

describe('resolveDesktopProduct', () => {
  it('reads the reduced product off the name electron-builder writes', () => {
    expect(resolveDesktopProduct(env({ appName: VIEWER_APP_NAME }))).toBe('viewer')
  })

  it('also accepts the display name, since Electron prefers productName', () => {
    expect(resolveDesktopProduct(env({ appName: VIEWER_PRODUCT_NAME }))).toBe('viewer')
  })

  it('is the node product for every other packaged name', () => {
    expect(resolveDesktopProduct(env({ appName: 'camstack' }))).toBe('node')
    expect(resolveDesktopProduct(env({ appName: 'CamStack' }))).toBe('node')
    expect(resolveDesktopProduct(env({ appName: '@camstack/desktop' }))).toBe('node')
    expect(resolveDesktopProduct(env({ appName: '' }))).toBe('node')
  })

  it('is the node product for an unpackaged run', () => {
    expect(resolveDesktopProduct(env({ isPackaged: false, appName: '@camstack/desktop' }))).toBe(
      'node',
    )
  })

  it('lets an unpackaged run ask for the reduced product explicitly', () => {
    expect(resolveDesktopProduct(env({ isPackaged: false, override: 'viewer' }))).toBe('viewer')
    expect(resolveDesktopProduct(env({ isPackaged: false, override: 'node' }))).toBe('node')
    expect(resolveDesktopProduct(env({ isPackaged: false, override: 'nonsense' }))).toBe('node')
  })

  it('ignores the override in a packaged app, in BOTH directions', () => {
    expect(resolveDesktopProduct(env({ appName: VIEWER_APP_NAME, override: 'node' }))).toBe(
      'viewer',
    )
    expect(resolveDesktopProduct(env({ appName: 'camstack', override: 'viewer' }))).toBe('node')
  })

  it('names the override variable so the docs and the code cannot drift', () => {
    expect(PRODUCT_OVERRIDE_ENV_VAR).toBe('CAMSTACK_DESKTOP_PRODUCT')
  })
})
