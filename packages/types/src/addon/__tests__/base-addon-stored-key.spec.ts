/**
 * `readStoredGlobalKey` (D651): whether a key of an addon's own store was
 * WRITTEN, three ways. The hydrated view cannot say it — it answers
 * `value ?? default` — and `readAddonStore` folds a failed read into `{}`.
 *
 * This is the RAW read: a key written as `null` is present with `null`. What
 * a stored `null` MEANS for a given key is the caller's question
 * (`interpretStoredClusterModel` reads it as absent for the cluster model).
 */
import { describe, expect, it } from 'vitest'
import type { AddonStoreRead } from '../../interfaces/addon.js'
import { BaseAddon } from '../base-addon.js'
import { fakeAddonContext } from './fake-addon-context.js'

class TestAddon extends BaseAddon {
  protected async onInitialize() {
    return []
  }
  pubRead(key: string) {
    return this.readStoredGlobalKey(key)
  }
}

async function readWith(readResult: (() => Promise<AddonStoreRead>) | undefined, key = 'k') {
  const a = new TestAddon({})
  await a.initialize(
    fakeAddonContext({
      settings: readResult !== undefined ? { readAddonStoreResult: readResult } : {},
    }),
  )
  return a.pubRead(key)
}

describe('BaseAddon.readStoredGlobalKey', () => {
  it('a written key is present, with its stored value — null included', async () => {
    expect(await readWith(async () => ({ kind: 'value', value: { k: 'x' } }))).toEqual({
      kind: 'present',
      value: 'x',
    })
    expect(await readWith(async () => ({ kind: 'value', value: { k: null } }))).toEqual({
      kind: 'present',
      value: null,
    })
  })

  it('a blob without the key, or no blob, is absent', async () => {
    expect(await readWith(async () => ({ kind: 'value', value: { other: 1 } }))).toEqual({
      kind: 'absent',
    })
    expect(await readWith(async () => ({ kind: 'missing' }))).toEqual({ kind: 'absent' })
  })

  it('a FAILED read is unreadable — never absent', async () => {
    expect(await readWith(async () => ({ kind: 'failed', error: 'down' }))).toEqual({
      kind: 'unreadable',
      reason: 'store-read-failed',
      error: 'down',
    })
  })

  it('a read that throws is unreadable', async () => {
    expect(
      await readWith(async () => {
        throw new Error('boom')
      }),
    ).toEqual({ kind: 'unreadable', reason: 'store-read-failed', error: 'boom' })
  })

  it('a settings view without the three-way read is unreadable, not empty', async () => {
    expect(await readWith(undefined)).toEqual({
      kind: 'unreadable',
      reason: 'three-way-read-unavailable',
    })
  })
})
