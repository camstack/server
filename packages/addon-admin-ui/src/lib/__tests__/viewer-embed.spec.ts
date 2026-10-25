import { resetHubMountForTests } from '@camstack/ui-library'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { planViewerEmbed } from '../viewer-embed'

/**
 * The admin UI frames the viewer at the ROOT mount only. Under a path prefix
 * (the Home Assistant relay) the viewer — an Expo export whose base path is
 * baked in at build time — would ask for `/viewer/camstack/_expo/…` on the
 * relay's origin and paint a page of 404s, so the plan says so instead of
 * framing (D425).
 */

beforeEach(() => {
  resetHubMountForTests()
  document.head.innerHTML = ''
})

afterEach(() => {
  resetHubMountForTests()
  document.head.innerHTML = ''
})

describe('planViewerEmbed', () => {
  it('at the root mount: frame the hub-served viewer, same origin', () => {
    expect(planViewerEmbed()).toEqual({ kind: 'frame', src: '/viewer/camstack/' })
  })

  it('under a mount prefix: no frame, and the prefix is named', () => {
    document.head.innerHTML =
      '<base href="/api/camstack/p/g1/"><meta name="camstack-mount" content="/api/camstack/p/g1/">'
    expect(planViewerEmbed()).toEqual({
      kind: 'unavailable-under-mount',
      mount: '/api/camstack/p/g1',
    })
  })

  it('is decided by the basename it is given, not by the document', () => {
    expect(planViewerEmbed('')).toEqual({ kind: 'frame', src: '/viewer/camstack/' })
    expect(planViewerEmbed('/x/g1')).toEqual({ kind: 'unavailable-under-mount', mount: '/x/g1' })
  })
})
