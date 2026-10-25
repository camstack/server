/**
 * AddonPageLoader must not clear the loaded remote component when the pages
 * list refetches and produces a new `page` object with the same remote.
 *
 * Asserted on source: a render harness would mostly re-mock Module Federation
 * and the pages query; the structural fact is the effect dependency list.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(join(__dirname, '..', 'AddonPageLoader.tsx'), 'utf-8')

describe('AddonPageLoader remote identity', () => {
  it('reloads only when remoteName / bundleUrl change, not page object identity', () => {
    expect(src).toContain('[remoteName, bundleUrl]')
    expect(src).not.toMatch(/\}, \[page\]\)/)
    // Clearing the mounted component is gated on a cache miss for that remote
    expect(src).toContain('pageComponentCache.get(remoteName)')
    const effectBody = src.slice(
      src.indexOf('useEffect(() => {'),
      src.indexOf('[remoteName, bundleUrl]'),
    )
    expect(effectBody).toContain('setPageComponent(null)')
    // nulling must not run unconditionally before the cache check
    const nullAt = effectBody.indexOf('setPageComponent(null)')
    const cacheAt = effectBody.indexOf('pageComponentCache.get(remoteName)')
    expect(cacheAt).toBeGreaterThanOrEqual(0)
    expect(nullAt).toBeGreaterThan(cacheAt)
  })
})
