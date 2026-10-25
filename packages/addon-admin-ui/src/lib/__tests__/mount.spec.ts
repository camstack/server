import { resetHubMountForTests } from '@camstack/ui-library'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hubOrigin, hubPath, hubUrl, hubWsUrl, mountPath, routerBasename } from '../mount'

/**
 * The admin UI's door to the hub mount. The logic is tested where it lives
 * (`ui-library/src/lib/__tests__/hub-mount.spec.ts`); this pins that the
 * admin UI sees the SAME resolution — with and without the shell injection —
 * through its own module, so a future local copy cannot drift from it.
 */

beforeEach(() => {
  resetHubMountForTests()
  document.head.innerHTML = ''
})

afterEach(() => {
  resetHubMountForTests()
  document.head.innerHTML = ''
})

describe('mount (admin UI)', () => {
  it('without <base>: today’s root-mounted behaviour, byte for byte', () => {
    expect(mountPath()).toBe('/')
    expect(routerBasename()).toBe('')
    expect(hubPath('/api/webrtc')).toBe('/api/webrtc')
    expect(hubOrigin()).toBe(window.location.origin)
    expect(hubUrl('/trpc')).toBe(`${window.location.origin}/trpc`)
  })

  it('with the shell injection: every hub URL starts with the mount', () => {
    document.head.innerHTML =
      '<base href="/api/camstack/p/g1/"><meta name="camstack-mount" content="/api/camstack/p/g1/">'
    expect(mountPath()).toBe('/api/camstack/p/g1/')
    expect(routerBasename()).toBe('/api/camstack/p/g1')
    expect(hubPath('/api/webrtc?src=a')).toBe('/api/camstack/p/g1/api/webrtc?src=a')
    expect(hubOrigin()).toBe(`${window.location.origin}/api/camstack/p/g1`)
    expect(hubWsUrl('/trpc')).toBe(
      `${window.location.origin.replace(/^http/, 'ws')}/api/camstack/p/g1/trpc`,
    )
  })
})
