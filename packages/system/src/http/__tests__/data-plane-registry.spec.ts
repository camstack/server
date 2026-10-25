import type { AddonDataPlaneEndpoint } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { canServeDataPlane, DataPlaneRegistry } from '../data-plane-registry.js'

const ep = (prefix: string): AddonDataPlaneEndpoint => ({
  prefix,
  access: 'admin',
  baseUrl: 'http://127.0.0.1:51000',
  secret: 's',
})

describe('DataPlaneRegistry', () => {
  it('matches a request under a registered prefix and returns the remaining path', () => {
    const reg = new DataPlaneRegistry()
    reg.registerAddon('recorder', [ep('playback')])

    const m = reg.match('recorder', '/playback/7/low/seg.m4s')
    expect(m).not.toBeNull()
    expect(m?.endpoint.prefix).toBe('playback')
    expect(m?.rest).toBe('/7/low/seg.m4s')
  })

  it('matches the prefix root itself (rest = "/")', () => {
    const reg = new DataPlaneRegistry()
    reg.registerAddon('recorder', [ep('playback')])
    expect(reg.match('recorder', 'playback')?.rest).toBe('/')
    expect(reg.match('recorder', '/playback/')?.rest).toBe('/')
  })

  it('does NOT match a different addon or a non-prefix path', () => {
    const reg = new DataPlaneRegistry()
    reg.registerAddon('recorder', [ep('playback')])
    expect(reg.match('other', '/playback/7')).toBeNull()
    expect(reg.match('recorder', '/scrub/7')).toBeNull()
    // A prefix must align on a segment boundary, not a substring.
    expect(reg.match('recorder', '/playbackX/7')).toBeNull()
  })

  it('picks the LONGEST matching prefix', () => {
    const reg = new DataPlaneRegistry()
    reg.registerAddon('a', [ep('media'), ep('media/hls')])
    const m = reg.match('a', '/media/hls/7/seg.m4s')
    expect(m?.endpoint.prefix).toBe('media/hls')
    expect(m?.rest).toBe('/7/seg.m4s')
  })

  it('registerAddon replaces; empty set clears', () => {
    const reg = new DataPlaneRegistry()
    reg.registerAddon('recorder', [ep('playback')])
    expect(reg.has('recorder')).toBe(true)
    reg.registerAddon('recorder', [])
    expect(reg.has('recorder')).toBe(false)
    expect(reg.match('recorder', '/playback/7')).toBeNull()
  })

  it("unregisterAddon drops all of an addon's endpoints", () => {
    const reg = new DataPlaneRegistry()
    reg.registerAddon('recorder', [ep('playback')])
    reg.unregisterAddon('recorder')
    expect(reg.match('recorder', '/playback/7')).toBeNull()
  })
})

/**
 * `unregisterAddon` had no call site anywhere in the repo.
 *
 * The hub pulls an addon's data-planes on any cap-changed signal and replaces
 * them wholesale, which handles the happy path — a restarted child re-
 * handshakes, caps re-register, the fresh `baseUrl` lands. What nothing handled
 * was every path that ends in "this addon cannot serve a data-plane right now":
 * the child is gone from the child registry, the entry is no longer a forked
 * addon, or the addon was removed from disk entirely. Each of those left the
 * PREVIOUS registration standing, so `/addon/<id>/*` kept reverse-proxying at
 * the port of a process that no longer exists — a 502 per request until the
 * replacement finished handshaking, and forever for a removed addon.
 *
 * These assert the property the fix depends on: dropping is the safe direction.
 * An absent data-plane falls through to the control-route path; a stale one
 * sends live traffic at a dead socket.
 */
describe('unregisterAddon leaves no route behind', () => {
  const endpoint = {
    prefix: '/media',
    access: 'authenticated',
    baseUrl: 'http://127.0.0.1:41111',
    secret: 's',
  } as const

  it('stops matching every prefix the addon had', () => {
    const registry = new DataPlaneRegistry()
    registry.registerAddon('@camstack/addon-post-analysis', [endpoint])
    expect(registry.match('@camstack/addon-post-analysis', '/media/7/crop.jpg')).not.toBeNull()

    registry.unregisterAddon('@camstack/addon-post-analysis')

    expect(registry.match('@camstack/addon-post-analysis', '/media/7/crop.jpg')).toBeNull()
    expect(registry.has('@camstack/addon-post-analysis')).toBe(false)
  })

  it('is idempotent — a dead child can be reported more than once', () => {
    const registry = new DataPlaneRegistry()
    registry.registerAddon('a', [endpoint])
    registry.unregisterAddon('a')
    expect(() => registry.unregisterAddon('a')).not.toThrow()
    expect(registry.has('a')).toBe(false)
  })

  it('touches only the addon named', () => {
    const registry = new DataPlaneRegistry()
    registry.registerAddon('a', [endpoint])
    registry.registerAddon('b', [endpoint])
    registry.unregisterAddon('a')
    expect(registry.has('a')).toBe(false)
    expect(registry.has('b')).toBe(true)
  })
})

/**
 * The predicate is the fix. Every `false` must mean UNREGISTER.
 */
describe('canServeDataPlane', () => {
  const serving = { hasEntry: true, isForked: true, childKnown: true }

  it('serves only when the addon is present, forked and its child is alive', () => {
    expect(canServeDataPlane(serving)).toBe(true)
  })

  it('refuses when the addon is gone from disk — nothing will ever refresh it', () => {
    expect(canServeDataPlane({ ...serving, hasEntry: false })).toBe(false)
  })

  it('refuses a non-forked entry — no builtin serves a data-plane today', () => {
    expect(canServeDataPlane({ ...serving, isForked: false })).toBe(false)
  })

  it('refuses while the child is unknown — this is the 502 window', () => {
    expect(canServeDataPlane({ ...serving, childKnown: false })).toBe(false)
  })
})
