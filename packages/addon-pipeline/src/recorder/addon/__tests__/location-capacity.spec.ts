/**
 * Volume capacity for one recordings location, and the rule that a volume
 * which will not answer must SAY SO.
 *
 * The failure path is the whole point: a network root that stops responding
 * used to produce `{ availableBytes: null, totalBytes: null }` from a bare
 * `catch {}` — indistinguishable from a filesystem that has no notion of
 * capacity, and invisible in the logs. The reason travels with the answer so
 * the provider can log it against the location.
 */
import { describe, expect, it } from 'vitest'
import { readLocationCapacity, type StatfsFn } from '../location-capacity.js'

const okStatfs: StatfsFn = async () => ({ bsize: 4_096, bavail: 250_000, blocks: 1_000_000 })

describe('readLocationCapacity', () => {
  it('derives free/total from bsize × bavail / bsize × blocks', async () => {
    const cap = await readLocationCapacity('/mnt/recordings', okStatfs)
    expect(cap).toEqual({
      availableBytes: 4_096 * 250_000,
      totalBytes: 4_096 * 1_000_000,
    })
  })

  it('statfs of the root it was asked about, not of anything else', async () => {
    const seen: string[] = []
    await readLocationCapacity('/mnt/nas', async (root) => {
      seen.push(root)
      return { bsize: 512, bavail: 1, blocks: 2 }
    })
    expect(seen).toEqual(['/mnt/nas'])
  })

  it('a volume that will not answer yields nulls AND the reason — never a throw', async () => {
    const cap = await readLocationCapacity('/mnt/dead-nas', async () => {
      throw new Error('EIO: i/o error, statfs')
    })
    expect(cap.availableBytes).toBeNull()
    expect(cap.totalBytes).toBeNull()
    expect(cap.error).toContain('EIO')
  })

  it('a successful read carries no error — "unknown" and "failed" stay distinguishable', async () => {
    const cap = await readLocationCapacity('/mnt/recordings', okStatfs)
    expect(cap.error).toBeUndefined()
  })
})
