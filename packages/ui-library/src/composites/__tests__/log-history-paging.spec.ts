import { describe, it, expect, vi } from 'vitest'
import {
  collectPage,
  mergeLogEntries,
  logEntryKey,
  type FetchLogSlice,
  type LogWireEntry,
  type LogWirePage,
} from '../log-history-paging'

function entry(n: number, extra: Partial<LogWireEntry> = {}): LogWireEntry {
  return {
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    level: 'info',
    message: `line ${n}`,
    ...extra,
  }
}

function page(entries: LogWireEntry[], over: Partial<LogWirePage> = {}): LogWirePage {
  return {
    entries,
    nextBefore: 'c',
    nextAfter: null,
    scannedBytes: 1000,
    done: false,
    source: 'winston-logging',
    ...over,
  }
}

describe('mergeLogEntries', () => {
  it('dedupes live vs history by id and orders chronologically', () => {
    const history = [entry(3, { id: 'c' }), entry(2, { id: 'b' })]
    const live = [entry(3, { id: 'c', tags: { deviceId: '1' } }), entry(4, { id: 'd' })]
    const merged = mergeLogEntries(history, live)
    expect(merged.map((e) => e.id)).toEqual(['b', 'c', 'd'])
    expect(merged[1]?.tags).toEqual({ deviceId: '1' })
  })

  it('falls back to timestamp|level|scope|message when id is absent', () => {
    const a = entry(1)
    expect(logEntryKey(a)).toBe(`${a.timestamp}|info||line 1`)
    expect(mergeLogEntries([a], [{ ...a }])).toHaveLength(1)
  })

  it('does not merge distinct ids with identical text', () => {
    const merged = mergeLogEntries([entry(1, { id: 'x' })], [entry(1, { id: 'y' })])
    expect(merged).toHaveLength(2)
  })
})

describe('collectPage', () => {
  it('stops at the limit and returns the cursor', async () => {
    const fetchSlice = vi.fn<FetchLogSlice>(async () =>
      page([entry(2), entry(1)], { nextBefore: 'n1' }),
    )
    const out = await collectPage({ fetchSlice, limit: 2, signal: new AbortController().signal })
    expect(fetchSlice).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ nextBefore: 'n1', done: false, cancelled: false })
  })

  it('keeps calling with before=nextBefore while a short page says done:false, accumulating bytes', async () => {
    const slices = [
      page([], { nextBefore: 'a', scannedBytes: 5 }),
      page([entry(3)], { nextBefore: 'b', scannedBytes: 7 }),
      page([entry(2), entry(1)], { nextBefore: 'c', scannedBytes: 11 }),
    ]
    const calls: (string | undefined)[] = []
    const progress: number[] = []
    const fetchSlice: FetchLogSlice = async (before) => {
      calls.push(before)
      return slices[calls.length - 1]!
    }
    const out = await collectPage({
      fetchSlice,
      limit: 3,
      signal: new AbortController().signal,
      onProgress: (n) => progress.push(n),
    })
    expect(calls).toEqual([undefined, 'a', 'b'])
    expect(out.entries).toHaveLength(3)
    expect(out.scannedBytes).toBe(23)
    expect(progress).toEqual([5, 12, 23])
    expect(out.nextBefore).toBe('c')
  })

  it('stops when the source is done, even short', async () => {
    const fetchSlice: FetchLogSlice = async () => page([entry(1)], { done: true, nextBefore: null })
    const out = await collectPage({ fetchSlice, limit: 50, signal: new AbortController().signal })
    expect(out).toMatchObject({ done: true, nextBefore: null, cancelled: false })
  })

  it('cancel aborts the in-flight slice and keeps the cursor reached', async () => {
    const ctrl = new AbortController()
    let n = 0
    const fetchSlice: FetchLogSlice = (_before, _remaining, signal) => {
      n += 1
      if (n === 1) return Promise.resolve(page([entry(1)], { nextBefore: 'k' }))
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')))
        queueMicrotask(() => ctrl.abort())
      })
    }
    const out = await collectPage({ fetchSlice, limit: 10, signal: ctrl.signal })
    expect(out).toMatchObject({ cancelled: true, done: false, nextBefore: 'k' })
    expect(out.entries).toHaveLength(1)
  })

  it('rethrows a real failure', async () => {
    const fetchSlice: FetchLogSlice = async () => {
      throw new Error('boom')
    }
    await expect(
      collectPage({ fetchSlice, limit: 5, signal: new AbortController().signal }),
    ).rejects.toThrow('boom')
  })
})
