/**
 * Where the NEXT event-media blob lands follows the location set without a
 * restart (2026-10-20: after `eventMedia:default` was set to `drain`, new media
 * still landed there because the pick was cached for the life of the process and
 * only a migration lease ever reset it).
 *
 * The locator is driven the way production drives it: `resolve` per blob, and
 * `invalidate` from the `StorageLocationsChanged` doorbell (D387).
 */
import type { IScopedLogger, StorageLocation, StorageLocationMode } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  EventMediaWriteLocator,
  subscribeEventMediaWriteLocator,
} from '../event-media-write-location.js'

function logger(): IScopedLogger {
  const l = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
    withTags: vi.fn(),
  }
  l.child.mockReturnValue(l)
  l.withTags.mockReturnValue(l)
  // Documented type boundary: the locator only calls these levels.
  return l as unknown as IScopedLogger
}

function location(id: string, mode: StorageLocationMode, availableBytes: number): StorageLocation {
  // Documented type boundary: only the fields the locator reads.
  return {
    id,
    type: 'eventMedia',
    mode,
    config: {},
    capacity: { availableBytes },
  } as unknown as StorageLocation
}

function setup() {
  const modes = new Map<string, StorageLocationMode>([
    ['eventMedia:default', 'active'],
    ['eventMedia:ssd', 'active'],
  ])
  const list = vi.fn(
    async (): Promise<readonly StorageLocation[]> => [
      location('eventMedia:default', modes.get('eventMedia:default') ?? 'active', 900),
      location('eventMedia:ssd', modes.get('eventMedia:ssd') ?? 'active', 100),
    ],
  )
  const locator = new EventMediaWriteLocator({ list })
  return { modes, list, locator }
}

describe('EventMediaWriteLocator', () => {
  it('(c) a mode change to drain moves the next write to another active location, no restart', async () => {
    const { modes, locator } = setup()
    expect(await locator.resolve(logger(), 101)).toBe('eventMedia:default')

    modes.set('eventMedia:default', 'drain')
    // The doorbell rings.
    locator.invalidate()

    expect(await locator.resolve(logger(), 101)).toBe('eventMedia:ssd')
  })

  it('without the doorbell the old pick is still served (why the invalidation exists)', async () => {
    const { modes, locator, list } = setup()
    await locator.resolve(logger(), 101)
    modes.set('eventMedia:default', 'drain')
    expect(await locator.resolve(logger(), 101)).toBe('eventMedia:default')
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('keeps writing where it was while that stays writable (stickiness survives a ring)', async () => {
    const { locator } = setup()
    await locator.resolve(logger(), 101)
    locator.invalidate()
    expect(await locator.resolve(logger(), 101)).toBe('eventMedia:default')
  })

  it('refuses with a named error when nothing is writable after the ring', async () => {
    const { modes, locator } = setup()
    await locator.resolve(logger(), 101)
    modes.set('eventMedia:default', 'readonly')
    modes.set('eventMedia:ssd', 'disabled')
    locator.invalidate()
    await expect(locator.resolve(logger(), 101)).rejects.toThrow(/no writable eventMedia/)
  })

  it('the doorbell subscription drives invalidate()', async () => {
    const { modes, locator } = setup()
    let ring: ((event: { data: { locationId: string; reason: string } }) => void) | undefined
    const unsubscribe = vi.fn()
    const eventBus = {
      subscribe: vi.fn((filter: { category: string }, handler: typeof ring) => {
        expect(filter.category).toBe(EventCategory.StorageLocationsChanged)
        ring = handler
        return unsubscribe
      }),
    }
    // Documented type boundary: the helper only calls `subscribe`.
    const off = subscribeEventMediaWriteLocator(eventBus as never, locator, vi.fn())

    expect(await locator.resolve(logger(), 101)).toBe('eventMedia:default')
    modes.set('eventMedia:default', 'drain')
    ring?.({ data: { locationId: 'eventMedia:default', reason: 'upsert' } })
    expect(await locator.resolve(logger(), 101)).toBe('eventMedia:ssd')

    off()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
