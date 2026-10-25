import { describe, expect, it } from 'vitest'
import type { DeviceHistoryQueryManyEntry, DeviceHistoryQueryResult } from '@camstack/types'
import {
  decodeSeriesRef,
  encodeSeriesRef,
  historyPageHref,
  HISTORY_SELECTION_MAX,
  normalizeSelection,
  readHistoryPanels,
  withHiddenChart,
  withPanel,
  type HistorySeriesRef,
} from '../history-selection'
import { readHistory, type HistoryReader } from '../history-reads'
import { decodeCustomWindow, previousWindow, resolveHistoryWindow } from '../history-window'
import { anchorNow } from '../use-device-history'

const H = 3_600_000
const D = 24 * H

describe('compare window', () => {
  it('reads the period of the same length just before, shifted to overlay', () => {
    const w = resolveHistoryWindow('7d', 100 * D)
    expect(w).toEqual({ from: 93 * D, to: 100 * D })
    expect(previousWindow(w)).toEqual({ window: { from: 86 * D, to: 93 * D }, shiftMs: 7 * D })
  })

  it('falls back to the last day for a custom range that is not one', () => {
    expect(resolveHistoryWindow('custom', 10 * D, { from: 5, to: 5 })).toEqual({
      from: 9 * D,
      to: 10 * D,
    })
    expect(decodeCustomWindow('9-3')).toBeNull()
    expect(decodeCustomWindow('3-9')).toEqual({ from: 3, to: 9 })
  })

  it('anchors "now" coarser for a wider window, so the read key is stable', () => {
    expect(anchorNow(H + 1, D)).toBe(H + 60_000)
    expect(anchorNow(H + 1, 365 * D)).toBe(2 * H)
  })
})

describe('selection in the URL', () => {
  const ref: HistorySeriesRef = {
    subject: { kind: 'device', deviceId: 42 },
    key: 'cap:climate-control.currentTemp',
    scope: 'zone,a|person',
  }

  it('round-trips a ref whose key and scope carry separators', () => {
    expect(decodeSeriesRef(encodeSeriesRef(ref))).toEqual(ref)
    const node: HistorySeriesRef = {
      subject: { kind: 'node', nodeId: 'garage-nuc' },
      key: 'addon:metrics-native/node-cpu-percent',
      scope: '',
    }
    expect(decodeSeriesRef(encodeSeriesRef(node))).toEqual(node)
  })

  it('refuses a malformed value instead of guessing', () => {
    expect(decodeSeriesRef('d,abc,cap:x,')).toBeNull()
    expect(decodeSeriesRef('x,1,cap:x,')).toBeNull()
    expect(decodeSeriesRef('d,1,,')).toBeNull()
  })

  it('dedups and caps a selection at one batch', () => {
    const many = Array.from({ length: 30 }, (_v, i) => ({ ...ref, scope: String(i % 26) }))
    expect(normalizeSelection(many)).toHaveLength(HISTORY_SELECTION_MAX)
  })

  it('builds the History page link', () => {
    expect(historyPageHref([ref], '30d')).toMatch(/^\/system\/history\?s=d%2C42%2C.*&window=30d$/)
  })
})

describe('saved panels row', () => {
  it('reads an absent row as empty, and an unreadable one as NOT writable', () => {
    expect(readHistoryPanels(undefined).parsed).toBe(true)
    expect(readHistoryPanels({ version: 2 }).parsed).toBe(false)
  })

  it('hides and shows a chart per device without touching the others', () => {
    const v0 = readHistoryPanels({ version: 1, panels: [], hidden: { '7': ['a'] } }).value
    const v1 = withHiddenChart(v0, 9, 'b', true)
    expect(v1.hidden).toEqual({ '7': ['a'], '9': ['b'] })
    expect(withHiddenChart(v1, 9, 'b', false).hidden).toEqual({ '7': ['a'] })
  })

  it('replaces a panel by id', () => {
    const v0 = readHistoryPanels(undefined).value
    const p = { id: 'p', name: 'A', window: '7d' as const, selection: [] }
    const v1 = withPanel(withPanel(v0, p), { ...p, name: 'B' })
    expect(v1.panels.map((x) => x.name)).toEqual(['B'])
  })
})

describe('readHistory', () => {
  const ok = (key: string): DeviceHistoryQueryManyEntry => ({
    ok: true,
    result: {
      resolution: 'raw',
      truncated: false,
      series: [{ scope: key, before: null, points: [], derivedFrom: null }],
    },
  })

  it('batches at 24 and keeps one entry per item, in order', async () => {
    const calls: number[] = []
    const reader: HistoryReader = {
      queryMany: async (i) => {
        calls.push(i.items.length)
        return { results: i.items.map((it) => ok(it.key)) }
      },
      query: async () => {
        throw new Error('not used')
      },
    }
    const items = Array.from({ length: 30 }, (_v, i) => ({ deviceId: 1, key: `k${String(i)}` }))
    const out = await readHistory(reader, items, { from: 0, to: 1 })
    expect(calls).toEqual([24, 6])
    expect(out.map((e) => (e.ok ? e.result.series[0]?.scope : null))).toEqual(
      items.map((i) => i.key),
    )
  })

  it('falls back to one read per DEVICE item when the principal is refused queryMany', async () => {
    const reader: HistoryReader = {
      queryMany: async () => {
        throw Object.assign(new Error('forbidden'), { data: { code: 'FORBIDDEN' } })
      },
      query: async (i): Promise<DeviceHistoryQueryResult> => {
        const entry = ok(i.key)
        if (!entry.ok) throw new Error('unreachable')
        return entry.result
      },
    }
    const out = await readHistory(
      reader,
      [
        { deviceId: 1, key: 'a' },
        { forNodeId: 'hub', key: 'b' },
      ],
      { from: 0, to: 1 },
    )
    expect(out[0]?.ok).toBe(true)
    expect(out[1]).toEqual({ ok: false, error: 'forbidden' })
  })

  it('reports a failure per item rather than an empty series', async () => {
    const reader: HistoryReader = {
      queryMany: async () => {
        throw new Error('hub down')
      },
      query: async () => {
        throw new Error('not used')
      },
    }
    const out = await readHistory(reader, [{ deviceId: 1, key: 'a' }], { from: 0, to: 1 })
    expect(out).toEqual([{ ok: false, error: 'hub down' }])
  })
})
