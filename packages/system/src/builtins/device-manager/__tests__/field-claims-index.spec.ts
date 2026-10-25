/**
 * `FieldClaimsIndex` — the three ways a load does NOT succeed, each of which
 * must answer `not-loaded` with a reason and never an empty index (D49, D315):
 * a settings view that predates the three-way read, a store that answers
 * `failed`, and a blob that is on the store but malformed. A loaded-but-wrong
 * index would let `ensureSeeded` skip a claimed device's row and the next
 * native write would erase its `$owned` — the exact direction the brief named.
 */
import type { AddonStoreRead, IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { DeviceManagerSettings } from '../device-meta-store.js'
import { FIELD_CLAIMS_INDEX_KEY, FieldClaimsIndex } from '../field-claims-index.js'
import { createWriteLock } from '../write-lock.js'

function logger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

/** Only the two members the index reaches; the rest of the door is not asked. Documented type boundary. */
function settingsWith(read: (() => Promise<AddonStoreRead>) | undefined): DeviceManagerSettings {
  const door = {
    readAddonStoreResult: read,
    writeAddonStore: vi.fn(async () => undefined),
  }
  return door as unknown as DeviceManagerSettings
}

function index(): FieldClaimsIndex {
  return new FieldClaimsIndex({ logger: logger(), withAddonStoreWriteLock: createWriteLock() })
}

const VALID = {
  deviceId: 7,
  capName: 'battery',
  owner: 'blk-1',
  mode: 'replace',
  fields: ['percentage'],
}

describe('FieldClaimsIndex — what does not load', () => {
  it('a settings view without the three-way read is not loaded, by name', async () => {
    const idx = index()
    expect(await idx.load(settingsWith(undefined))).toBe(false)
    expect(idx.view()).toEqual({ state: 'not-loaded' })
    const listing = idx.list()
    expect(listing.state).toBe('not-loaded')
    if (listing.state === 'not-loaded') expect(listing.reason).toMatch(/three-way addon-store read/)
  })

  it('a failed store read is not loaded, with the store error as the reason', async () => {
    const idx = index()
    const settings = settingsWith(async () => ({ kind: 'failed', error: 'sqlite busy' }))
    expect(await idx.load(settings)).toBe(false)
    const listing = idx.list()
    if (listing.state === 'not-loaded') expect(listing.reason).toContain('sqlite busy')
    else throw new Error('loaded')
  })

  it('a blob that is not a list is UNKNOWN — not loaded, not empty (I-2)', async () => {
    const idx = index()
    const settings = settingsWith(async () => ({
      kind: 'value',
      value: { [FIELD_CLAIMS_INDEX_KEY]: { deviceId: 7 } },
    }))
    expect(await idx.load(settings)).toBe(false)
    expect(idx.view()).toEqual({ state: 'not-loaded' })
    const listing = idx.list()
    if (listing.state === 'not-loaded') expect(listing.reason).toMatch(/malformed/)
    else throw new Error('loaded')
  })

  it('a list with ONE malformed entry is unknown as a whole — the dropped one could be the claimed device', async () => {
    const idx = index()
    const settings = settingsWith(async () => ({
      kind: 'value',
      value: { [FIELD_CLAIMS_INDEX_KEY]: [VALID, { deviceId: 8 }] },
    }))
    expect(await idx.load(settings)).toBe(false)
    expect(idx.view()).toEqual({ state: 'not-loaded' })
    const listing = idx.list()
    if (listing.state === 'not-loaded') expect(listing.reason).toMatch(/position(s)? 1/)
    else throw new Error('loaded')
    // And it refuses to be written blind.
    await expect(idx.upsert({ ...VALID, mode: 'replace' }, settings)).rejects.toThrow(/not loaded/)
  })

  it('a missing store and a well-formed list both load', async () => {
    const empty = index()
    expect(await empty.load(settingsWith(async () => ({ kind: 'missing' })))).toBe(true)
    expect(empty.list()).toEqual({ state: 'loaded', claims: [] })

    const one = index()
    const settings = settingsWith(async () => ({
      kind: 'value',
      value: { [FIELD_CLAIMS_INDEX_KEY]: [VALID] },
    }))
    expect(await one.load(settings)).toBe(true)
    const view = one.view()
    expect(view.state === 'loaded' && view.hasClaims(7)).toBe(true)
    expect(view.state === 'loaded' && view.hasClaims(8)).toBe(false)
  })
})
