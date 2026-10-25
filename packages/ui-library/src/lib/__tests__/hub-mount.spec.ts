import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  hubOrigin,
  hubPath,
  hubUrl,
  hubWsUrl,
  mountPath,
  resetHubMountForTests,
  routerBasename,
} from '../hub-mount'

/**
 * The admin UI can be served under a path prefix decided at runtime by a
 * reverse proxy (the Home Assistant relay: `/api/camstack/p/<grant>/` →
 * hub `/`). The hub tells the page where it is mounted by injecting
 * `<base href>` + `<meta name="camstack-mount">` into the shell; every hub
 * URL the page composes must come from that one fact.
 */

function setHead(html: string): void {
  document.head.innerHTML = html
}

beforeEach(() => {
  resetHubMountForTests()
  setHead('')
})

afterEach(() => {
  resetHubMountForTests()
  setHead('')
})

describe('mountPath', () => {
  it('is the root when the shell carries neither <base> nor the mount meta', () => {
    expect(mountPath()).toBe('/')
    expect(routerBasename()).toBe('')
  })

  it('reads the injected mount meta', () => {
    setHead('<meta name="camstack-mount" content="/api/camstack/p/g1/">')
    expect(mountPath()).toBe('/api/camstack/p/g1/')
    expect(routerBasename()).toBe('/api/camstack/p/g1')
  })

  it('falls back to the <base> element when only that is present', () => {
    setHead('<base href="/x/g1/">')
    expect(mountPath()).toBe('/x/g1/')
  })

  it('normalises a mount without its trailing slash', () => {
    setHead('<meta name="camstack-mount" content="/x/g1">')
    expect(mountPath()).toBe('/x/g1/')
    expect(routerBasename()).toBe('/x/g1')
  })

  it('ignores a mount that is not a clean absolute path', () => {
    setHead('<meta name="camstack-mount" content="https://evil.example/x/">')
    expect(mountPath()).toBe('/')
    setHead('<meta name="camstack-mount" content="/x/../y/">')
    resetHubMountForTests()
    expect(mountPath()).toBe('/')
    setHead('<meta name="camstack-mount" content="//evil.example/">')
    resetHubMountForTests()
    expect(mountPath()).toBe('/')
  })

  it('is resolved once — a <base> added after the first read does not move the mount', () => {
    expect(mountPath()).toBe('/')
    setHead('<meta name="camstack-mount" content="/x/g1/">')
    expect(mountPath()).toBe('/')
  })
})

describe('hubPath — a same-origin path under the mount', () => {
  it('is the hub-root path when mounted at the root (today’s behaviour, unchanged)', () => {
    expect(hubPath('/api/webrtc')).toBe('/api/webrtc')
    expect(hubPath('api/webrtc')).toBe('/api/webrtc')
    expect(hubPath('/')).toBe('/')
  })

  it('prefixes the mount and keeps the query string', () => {
    setHead('<meta name="camstack-mount" content="/x/g1/">')
    expect(hubPath('/api/webrtc?src=cam-1')).toBe('/x/g1/api/webrtc?src=cam-1')
    expect(hubPath('/addon/pipeline-analytics/event-media/k%2F1')).toBe(
      '/x/g1/addon/pipeline-analytics/event-media/k%2F1',
    )
    expect(hubPath('/')).toBe('/x/g1/')
  })

  it('does not prefix twice, and passes an absolute URL through untouched', () => {
    setHead('<meta name="camstack-mount" content="/x/g1/">')
    expect(hubPath('/x/g1/api/webrtc')).toBe('/x/g1/api/webrtc')
    expect(hubPath('https://other.example/api/webrtc')).toBe('https://other.example/api/webrtc')
    expect(hubPath('//cdn.example/a.js')).toBe('//cdn.example/a.js')
  })
})

describe('hubOrigin / hubUrl / hubWsUrl — absolute bases for the SDK and the players', () => {
  it('is the page origin at the root, with no trailing slash', () => {
    expect(hubOrigin()).toBe(window.location.origin)
    expect(hubUrl('/trpc')).toBe(`${window.location.origin}/trpc`)
    expect(hubWsUrl('/trpc')).toBe(`${window.location.origin.replace(/^http/, 'ws')}/trpc`)
  })

  it('carries the mount so `${serverUrl}/trpc` lands under the prefix', () => {
    setHead('<meta name="camstack-mount" content="/x/g1/">')
    expect(hubOrigin()).toBe(`${window.location.origin}/x/g1`)
    expect(hubUrl('/api/webrtc?src=a')).toBe(`${window.location.origin}/x/g1/api/webrtc?src=a`)
    expect(hubWsUrl('/trpc')).toBe(`${window.location.origin.replace(/^http/, 'ws')}/x/g1/trpc`)
  })
})
