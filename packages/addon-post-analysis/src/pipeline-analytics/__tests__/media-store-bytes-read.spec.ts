/**
 * `MediaStore.getBytesById` — the in-process read that never builds the base64
 * string (D867). `getById` is the same read with the string on top, so the two
 * must agree byte for byte; a reader that moved to bytes cannot be told apart
 * from one that did not except by this equivalence.
 */
import { describe, expect, it } from 'vitest'
import { buildMediaStoreForTest, putOwnedMedia } from './media-store-test-helpers.js'

describe('MediaStore.getBytesById (D867)', () => {
  it('returns the stored bytes, and getById is exactly their base64', async () => {
    const { store } = await buildMediaStoreForTest()
    const data = Buffer.from([0xff, 0xd8, 0x00, 0x10, 0x20, 0xff, 0xd9])
    const id = await putOwnedMedia(store, {
      ownerKind: 'track',
      ownerId: 'A',
      kind: 'keyFrame',
      timestamp: 4000,
      data,
    })
    const bytes = await store.getBytesById(id)
    const wire = await store.getById(id)
    expect(bytes).not.toBeNull()
    expect(bytes!.bytes.equals(data)).toBe(true)
    expect(Buffer.isBuffer(bytes!.bytes)).toBe(true)
    expect(wire!.base64).toBe(data.toString('base64'))
    // Same row facts on both shapes.
    expect({ ...bytes, bytes: undefined }).toEqual({ ...wire, base64: undefined, bytes: undefined })
  })

  it('is null for an id that names no row', async () => {
    const { store } = await buildMediaStoreForTest()
    expect(await store.getBytesById(987_654)).toBeNull()
    expect(await store.getById(987_654)).toBeNull()
  })
})
