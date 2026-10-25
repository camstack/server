/**
 * Phase 3 seam: rows stamped with a locationId read/write/delete against that
 * location's RESOLVED root; unstamped (default) traffic stays on the bypass
 * provider byte-for-byte.
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createLocationAwareMediaStorage } from '../location-aware-media-storage.js'
import { mediaRowLocation, DEFAULT_MEDIA_LOCATION } from '../store/media-store.js'

function makeBase() {
  const calls: string[] = []
  return {
    calls,
    base: {
      write: async (i: { location: string; relativePath: string }) => {
        calls.push(`write:${i.location}:${i.relativePath}`)
      },
      read: async (i: { location: string; relativePath: string }) => {
        calls.push(`read:${i.location}:${i.relativePath}`)
        return Buffer.from('base')
      },
      delete: async (i: { location: string; relativePath: string }) => {
        calls.push(`delete:${i.location}:${i.relativePath}`)
      },
    },
  }
}

describe('createLocationAwareMediaStorage', () => {
  it('default-location traffic goes to the bypass provider untouched', async () => {
    const { base, calls } = makeBase()
    const resolveRoot = vi.fn()
    const s = createLocationAwareMediaStorage({
      base,
      defaultLocation: 'eventMedia',
      resolveRoot,
    })
    await s.write({
      location: 'eventMedia',
      relativePath: '5/events/a.jpg',
      data: Buffer.from('x'),
    })
    await s.read({ location: 'eventMedia', relativePath: '5/events/a.jpg' })
    await s.delete({ location: 'eventMedia', relativePath: '5/events/a.jpg' })
    expect(calls).toEqual([
      'write:eventMedia:5/events/a.jpg',
      'read:eventMedia:5/events/a.jpg',
      'delete:eventMedia:5/events/a.jpg',
    ])
    expect(resolveRoot).not.toHaveBeenCalled()
  })

  it('a stamped location resolves its root ONCE and does direct fs I/O there', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lams-'))
    const { base } = makeBase()
    const resolveRoot = vi.fn(async () => root)
    const s = createLocationAwareMediaStorage({
      base,
      defaultLocation: 'eventMedia',
      resolveRoot,
    })

    await s.write({
      location: 'recordings:disk2',
      relativePath: '7/events/track/t1/thumb.jpg',
      data: Buffer.from('blob'),
    })
    const abs = path.join(root, '7/events/track/t1/thumb.jpg')
    expect(readFileSync(abs).toString()).toBe('blob')
    expect(
      (
        await s.read({ location: 'recordings:disk2', relativePath: '7/events/track/t1/thumb.jpg' })
      ).toString(),
    ).toBe('blob')
    await s.delete({ location: 'recordings:disk2', relativePath: '7/events/track/t1/thumb.jpg' })
    expect(existsSync(abs)).toBe(false)
    expect(resolveRoot).toHaveBeenCalledTimes(1) // cached after the first hit
  })

  it('invalidates cached roots and stops using the old default bypass after repoint', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lams-refresh-'))
    const { base, calls } = makeBase()
    const resolveRoot = vi.fn(async () => root)
    const s = createLocationAwareMediaStorage({
      base,
      defaultLocation: 'eventMedia',
      resolveRoot,
    })
    await s.write({ location: 'eventMedia', relativePath: 'before.jpg', data: Buffer.from('a') })
    s.invalidateRoots()
    await s.write({ location: 'eventMedia', relativePath: 'after.jpg', data: Buffer.from('b') })
    expect(calls).toEqual(['write:eventMedia:before.jpg'])
    expect(resolveRoot).toHaveBeenCalledWith('eventMedia')
    expect(readFileSync(path.join(root, 'after.jpg')).toString()).toBe('b')
  })

  // "Le cartelle addons non devono trasportare nulla" [the addons folders must not carry anything] (operator, 2026-09-04,
  // D341): the enrolled gallery is a storage LOCATION again, resolved through
  // the orchestrator like every other stamped location — never a dir the
  // addon owns. Undoing 873b73e2c's addon-data pin.
  it('gallery writes resolve the galleryMedia location through the storage cap', async () => {
    const galleryRoot = mkdtempSync(path.join(tmpdir(), 'lams-gallery-'))
    const { base } = makeBase()
    const resolveRoot = vi.fn(async () => galleryRoot)
    const s = createLocationAwareMediaStorage({
      base,
      defaultLocation: 'eventMedia',
      resolveRoot,
    })
    await s.write({
      location: 'galleryMedia',
      relativePath: '592/events/identity/id-1/crop.jpg',
      data: Buffer.from('face'),
    })
    expect(
      readFileSync(path.join(galleryRoot, '592/events/identity/id-1/crop.jpg')).toString(),
    ).toBe('face')
    expect(resolveRoot).toHaveBeenCalledWith('galleryMedia')
  })
})

describe('mediaRowLocation', () => {
  it('NULL/absent locationId = the default location (every pre-Phase-3 row)', () => {
    expect(mediaRowLocation(undefined)).toBe(DEFAULT_MEDIA_LOCATION)
    expect(mediaRowLocation({})).toBe(DEFAULT_MEDIA_LOCATION)
    expect(mediaRowLocation({ locationId: null })).toBe(DEFAULT_MEDIA_LOCATION)
    expect(mediaRowLocation({ locationId: '' })).toBe(DEFAULT_MEDIA_LOCATION)
  })
  it('a stamped id wins', () => {
    expect(mediaRowLocation({ locationId: 'recordings:disk2' })).toBe('recordings:disk2')
  })
})

describe('createLocationAwareMediaStorage — a routed write is atomic (D654)', () => {
  it('a concurrent read of a stamped location never sees a torn file', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lams-atomic-'))
    const { base } = makeBase()
    const s = createLocationAwareMediaStorage({
      base,
      defaultLocation: 'eventMedia',
      resolveRoot: async () => root,
    })
    const size = 4 * 1024 * 1024
    const a = Buffer.alloc(size, 0x11)
    const b = Buffer.alloc(size, 0x22)
    const at = { location: 'loc-2', relativePath: '5/events/track/t/lastSceneFrame.jpg' }
    await s.write({ ...at, data: a })
    let writing = true
    const writer = (async () => {
      for (let i = 0; i < 30; i += 1) await s.write({ ...at, data: i % 2 === 0 ? b : a })
      writing = false
    })()
    const torn: number[] = []
    while (writing) {
      const got = await s.read(at)
      if (!(got.equals(a) || got.equals(b))) torn.push(got.length)
    }
    await writer
    expect(torn).toEqual([])
  })
})
