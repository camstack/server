/**
 * The zone-ownership mirror the `zones` condition scopes itself with.
 *
 * What is pinned here is the one distinction the whole fix rests on: a camera
 * a refresh could not answer for reads `undefined` (unknown ⇒ the flat,
 * pre-scoping verdict), NEVER `[]` (which means "no zones" and makes a rule's
 * zones inert for that camera). Collapsing the two would turn a failed read
 * into a notification the operator scoped away.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcZoneOwnershipCache } from '../zone-owner-cache.js'

/** A silent logger whose `warn` is observable — the per-camera "unknown" line
 *  is a behaviour of this cache, not decoration. */
function spyLogger(): { readonly logger: IScopedLogger; readonly warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn()
  const logger: IScopedLogger = { ...makeSilentLogger(), warn }
  return { logger, warn }
}

describe('NcZoneOwnershipCache', () => {
  it('serves the zone ids of every camera a refresh answered for', async () => {
    const cache = new NcZoneOwnershipCache({
      logger: makeSilentLogger(),
      readZoneIds: async () => new Map([[101, ['z-a']]]),
    })
    cache.setWatched([101])
    await cache.refresh()
    expect(cache.get(101)).toEqual(['z-a'])
    expect(cache.lookup()(101)).toEqual(['z-a'])
  })

  it('keeps `[]` and `undefined` apart — no zones vs unreadable', async () => {
    const cache = new NcZoneOwnershipCache({
      logger: makeSilentLogger(),
      // 102 answered "no zones"; 108 could not be read at all.
      readZoneIds: async () => new Map([[102, []]]),
    })
    cache.setWatched([102, 108])
    await cache.refresh()
    expect(cache.get(102)).toEqual([])
    expect(cache.get(108)).toBeUndefined()
  })

  it('says so, per camera, when a watched camera cannot be read', async () => {
    const { logger, warn } = spyLogger()
    const cache = new NcZoneOwnershipCache({
      logger,
      readZoneIds: async () => new Map(),
    })
    cache.setWatched([108])
    await cache.refresh()
    await cache.refresh()
    // Once per episode, not once per tick — and deviceId-tagged.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[1]).toEqual({ tags: { deviceId: 108 } })
  })

  it('keeps the previous catalogue when a refresh throws', async () => {
    let fail = false
    const cache = new NcZoneOwnershipCache({
      logger: makeSilentLogger(),
      readZoneIds: async () => {
        if (fail) throw new Error('zones cap unreachable')
        return new Map([[101, ['z-a']]])
      },
    })
    cache.setWatched([101])
    await cache.refresh()
    fail = true
    await cache.refresh()
    // Ownership is near-immutable — a polygon does not move to another camera —
    // so a blip must not re-mute the camera this scoping exists to un-mute.
    expect(cache.get(101)).toEqual(['z-a'])
  })

  it('does no work, and holds nothing, when no rule needs ownership', async () => {
    const readZoneIds = vi.fn(async () => new Map<number, readonly string[]>())
    const cache = new NcZoneOwnershipCache({ logger: makeSilentLogger(), readZoneIds })
    cache.setWatched([101])
    await cache.refresh()
    cache.setWatched([])
    await cache.refresh()
    expect(readZoneIds).toHaveBeenCalledTimes(1)
    expect(cache.get(101)).toBeUndefined()
    expect(cache.watched()).toEqual([])
  })
})
