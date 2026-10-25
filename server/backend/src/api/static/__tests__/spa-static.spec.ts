import { describe, expect, it } from 'vitest'
import {
  addonBundleCacheControl,
  isRetiredPublicPath,
  spaAssetCacheControl,
  spaShellCacheControl,
} from '../spa-static'

/**
 * Addon MF bundle cache policy — regression for the stale `_stub.js`
 * outage (2026-07-13): the exposes chunk emitted by the rolldown MF
 * plugin has a FIXED filename but mutable content. The old policy
 * assumed "everything that isn't the entry is content-hashed" and
 * stamped it `immutable` for a year — after an addon update, browsers
 * kept the old `_stub.js`, whose imports referenced hashed sibling
 * chunks that no longer existed (404 → widget load failure until a
 * manual hard-reload). Only names carrying a Vite content hash may be
 * immutable; everything else revalidates.
 */
describe('addonBundleCacheControl', () => {
  const IMMUTABLE = 'public, max-age=31536000, immutable'
  const REVALIDATE = 'no-cache, must-revalidate'

  it('MF entry points always revalidate', () => {
    expect(addonBundleCacheControl('/x/remoteEntry.js')).toBe(REVALIDATE)
    expect(addonBundleCacheControl('/x/widgets.mjs')).toBe(REVALIDATE)
  })

  it('content-hashed chunks are immutable', () => {
    expect(addonBundleCacheControl('/x/dist-CYZr2fwk.mjs')).toBe(IMMUTABLE)
    expect(addonBundleCacheControl('/x/virtualExposes-Ckj56FAf.mjs')).toBe(IMMUTABLE)
    expect(
      addonBundleCacheControl(
        '/x/_virtual_mf___mfe_internal__w__loadShare__react__loadShare__.js-BIIa6vDX.mjs',
      ),
    ).toBe(IMMUTABLE)
    // hash containing a hyphen (base64url alphabet)
    expect(addonBundleCacheControl('/x/loadShare__.js-CQ-aEQ9b.mjs')).toBe(IMMUTABLE)
  })

  it('fixed-name non-entry files revalidate (the _stub.js regression)', () => {
    expect(addonBundleCacheControl('/x/_stub.js')).toBe(REVALIDATE)
    expect(addonBundleCacheControl('/x/styles.css')).toBe(REVALIDATE)
    expect(addonBundleCacheControl('/x/some-component.mjs')).toBe(REVALIDATE)
  })
})

describe('spaAssetCacheControl', () => {
  it('PWA control files revalidate', () => {
    expect(spaAssetCacheControl('sw.js')).toBe('no-cache, must-revalidate')
    expect(spaAssetCacheControl('manifest.webmanifest')).toBe('no-cache, must-revalidate')
  })

  it('hashed build assets are immutable, the shell is not', () => {
    expect(spaAssetCacheControl('assets/index-B3xQz9aK.js')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(spaAssetCacheControl('embed/assets/index-B3xQz9aK.js')).toBe(
      'public, max-age=31536000, immutable',
    )
  })

  it('the shell served BY NAME gets the shell policy, not a weaker one', () => {
    // `GET /index.html` reaches the extension branch of the SPA handlers, not
    // the shell branch — it must not end up with a laxer policy than the same
    // bytes served at `/`.
    expect(spaAssetCacheControl('index.html')).toBe(spaShellCacheControl())
    expect(spaAssetCacheControl('embed/index.html')).toBe(spaShellCacheControl())
  })
})

/**
 * The SPA shell (`index.html`) is the ONE file that must never be reused across
 * a deploy: it carries the `<script src="assets/index-<hash>.js">` pointers, so
 * a stale copy loads a build whose hashed assets are gone — the operator sees
 * an old UI (or a blank page) until a force refresh. It is a few KB and every
 * in-app navigation is client-side, so refetching it costs nothing measurable.
 *
 * `no-store` rather than `no-cache`: the shell is streamed with no ETag and no
 * Last-Modified, so "revalidate" cannot produce a 304 anyway — and the response
 * then stays out of the back/forward and heuristic caches that made this
 * visible in the first place. Hashed assets keep their year-long immutable
 * policy; this applies to the HTML entry only.
 */
describe('spaShellCacheControl', () => {
  it('forbids storing the shell', () => {
    expect(spaShellCacheControl()).toBe('no-store')
  })

  it('never leaks onto hashed build assets', () => {
    expect(spaAssetCacheControl('assets/index-B3xQz9aK.js')).not.toBe(spaShellCacheControl())
    expect(addonBundleCacheControl('/x/dist-CYZr2fwk.mjs')).not.toBe(spaShellCacheControl())
  })
})

describe('isRetiredPublicPath', () => {
  it('retires the former stream-broker embed route and its assets', () => {
    expect(isRetiredPublicPath('/addon/stream-broker/embed')).toBe(true)
    expect(isRetiredPublicPath('/addon/stream-broker/embed/')).toBe(true)
    expect(isRetiredPublicPath('/addon/stream-broker/embed/assets/index.js?x=1')).toBe(true)
  })

  it('does not block other addon routes', () => {
    expect(isRetiredPublicPath('/addon/stream-broker/live')).toBe(false)
    expect(isRetiredPublicPath('/viewer/camstack/embed/index.html')).toBe(false)
  })
})
