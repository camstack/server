/**
 * Manifest / route wiring for the addon's own custom page.
 *
 * `AddonPageLoader` (packages/addon-admin-ui) dedupes ghost page
 * registrations by checking that `page.remoteName` contains the addon's
 * id with every non-alphanumeric run collapsed to `_`
 * (`item.page.remoteName.includes(item.addonId.replace(/[^a-zA-Z0-9]+/g, '_'))`).
 * A page whose `remoteName` doesn't satisfy that gets silently treated as
 * an orphan/duplicate and dropped from the sidebar — so this manifest's
 * shape is load-bearing, not cosmetic, and is worth locking down here
 * rather than only discovering it at runtime in the admin UI.
 */
import { describe, expect, it } from 'vitest'
import manifest from '../../package.json' with { type: 'json' }

function ownsPage(addonId: string, remoteName: string): boolean {
  return remoteName.includes(addonId.replace(/[^a-zA-Z0-9]+/g, '_'))
}

describe('addon manifest — pages wiring', () => {
  const addon = manifest.camstack.addons[0]
  if (!addon) throw new Error('manifest declares no addons')

  it('declares the addon-pages-source capability alongside osd-manager', () => {
    const names = addon.capabilities.map((c) => c.name)
    expect(names).toContain('osd-manager')
    expect(names).toContain('addon-pages-source')
  })

  it('docks its page under Detection', () => {
    expect(manifest.camstack.addons[0]?.pages?.[0]?.section).toBe('detection')
  })

  it('declares exactly one page for the OSD manager route', () => {
    expect(addon.pages).toHaveLength(1)
  })

  it('page fields are internally consistent with the MF bundle layout', () => {
    const page = addon.pages[0]
    if (!page) throw new Error('addon declares no pages')
    expect(page.path).toBe('/addon/osd-manager')
    expect(page.remoteName).toBe('addon_osd_manager_page')
    expect(page.bundle).toBe('remoteEntry.js')
    expect(page.id).toBe('osd-manager')
  })

  it("satisfies AddonPageLoader's ownership heuristic (never treated as a ghost dup)", () => {
    const page = addon.pages[0]
    if (!page) throw new Error('addon declares no pages')
    expect(ownsPage(addon.id, page.remoteName)).toBe(true)
  })

  it('build scripts produce both the server bundle and the page bundle', () => {
    expect(manifest.scripts.build).toContain('vite build')
    expect(manifest.scripts.build).toContain('vite.page.config.ts')
    expect(manifest.scripts['build:page']).toContain('vite.page.config.ts')
  })
})
