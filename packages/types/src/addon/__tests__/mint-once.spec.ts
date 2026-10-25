/**
 * §4 — mint-on-empty never trusts a value that did not read back.
 */
import { describe, expect, it, vi } from 'vitest'
import { mintOnceWithReadBack, type MintRefusalDetail } from '../mint-once.js'

interface Recorder {
  readonly refusals: MintRefusalDetail[]
  readonly onRefused: (detail: MintRefusalDetail) => void
}

function recorder(): Recorder {
  const refusals: MintRefusalDetail[] = []
  return { refusals, onRefused: (detail) => refusals.push(detail) }
}

describe('mintOnceWithReadBack', () => {
  it('reuses a stored value and never mints', async () => {
    const mint = vi.fn(() => 'fresh')
    const write = vi.fn(async () => undefined)
    const rec = recorder()
    const outcome = await mintOnceWithReadBack<string>({
      read: async () => 'stored',
      isEmpty: (v) => v === '',
      mint,
      write,
      onRefused: rec.onRefused,
    })
    expect(outcome).toEqual({ kind: 'existing', value: 'stored' })
    expect(mint).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('mints, persists and CONFIRMS on a genuinely empty store', async () => {
    let persisted = ''
    const rec = recorder()
    const outcome = await mintOnceWithReadBack<string>({
      read: async () => persisted,
      isEmpty: (v) => v === '',
      mint: () => 'minted',
      write: async (v) => {
        persisted = v
      },
      onRefused: rec.onRefused,
    })
    expect(outcome).toEqual({ kind: 'minted', value: 'minted' })
    expect(rec.refusals).toEqual([])
  })

  it('REFUSES when the write did not stick — the store is not answering', async () => {
    const rec = recorder()
    const outcome = await mintOnceWithReadBack<string>({
      // Always empty: this is what a store whose reads fail looks like.
      read: async () => '',
      isEmpty: (v) => v === '',
      mint: () => 'minted',
      write: async () => undefined,
      onRefused: rec.onRefused,
    })
    expect(outcome).toEqual({ kind: 'refused' })
    expect(rec.refusals).toEqual([{ reason: 'read-back-empty', readBackEmpty: true }])
  })

  it('REFUSES when the read-back disagrees — someone else owns that row', async () => {
    const rec = recorder()
    let reads = 0
    const outcome = await mintOnceWithReadBack<string>({
      read: async () => (reads++ === 0 ? '' : 'somebody-elses'),
      isEmpty: (v) => v === '',
      mint: () => 'minted',
      write: async () => undefined,
      onRefused: rec.onRefused,
    })
    expect(outcome).toEqual({ kind: 'refused' })
    expect(rec.refusals).toEqual([{ reason: 'read-back-mismatch', readBackEmpty: false }])
  })

  it('uses the supplied equality for object values (the HAP bridge identity)', async () => {
    interface Identity {
      readonly username: string
      readonly uuid: string
    }
    let persisted: Identity = { username: '', uuid: '' }
    const rec = recorder()
    const outcome = await mintOnceWithReadBack<Identity>({
      // A fresh object each read — reference equality would refuse forever.
      read: async () => ({ ...persisted }),
      isEmpty: (v) => v.username === '' || v.uuid === '',
      mint: () => ({ username: 'AA:BB', uuid: 'u-1' }),
      write: async (v) => {
        persisted = v
      },
      equals: (a, b) => a.username === b.username && a.uuid === b.uuid,
      onRefused: rec.onRefused,
    })
    expect(outcome).toEqual({ kind: 'minted', value: { username: 'AA:BB', uuid: 'u-1' } })
    expect(rec.refusals).toEqual([])
  })
})
