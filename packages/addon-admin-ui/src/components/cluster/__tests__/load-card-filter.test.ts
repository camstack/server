/**
 * Finding a runner on the Load tab.
 *
 * The assertions that matter are the two the operator asked for — a filter
 * NARROWS the cards, a sort REORDERS them — plus the two ways a filter/sort
 * pair silently lies: an empty selection that hides everything, and an unknown
 * value coerced to zero so a runner that stopped reporting is presented as the
 * idlest one on the node.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LOAD_SORT,
  cardCpuValue,
  cardMemoryValue,
  filterAndSortLoadCards,
  type LoadSortState,
} from '../load/load-card-filter'
import type { LoadSeries } from '../load/load-series'

interface SeriesShape {
  readonly key: string
  readonly cpuMain: number | null
  readonly cpuGc: number | null
  readonly cpuLifetime: number
  readonly rss: number
}

function series({ key, cpuMain, cpuGc, cpuLifetime, rss }: SeriesShape): LoadSeries {
  return {
    key,
    kind: 'addon',
    points: [
      {
        atMs: 1_000,
        cpuMainPercent: cpuMain,
        cpuGcPercent: cpuGc,
        cpuMainPercentMin: cpuMain,
        cpuGcPercentMin: cpuGc,
        cpuLifetimePercent: cpuLifetime,
        cpuLifetimePercentMin: cpuLifetime,
        memoryRssBytes: rss,
        memoryRssBytesMin: rss,
        processCount: 1,
        processCountMin: 1,
        samples: 1,
      },
    ],
  }
}

const BROKER = series({
  key: 'runner:stream-broker',
  cpuMain: 40,
  cpuGc: 5,
  cpuLifetime: 30,
  rss: 900,
})
const PIPELINE = series({
  key: 'runner:pipeline',
  cpuMain: 10,
  cpuGc: 1,
  cpuLifetime: 8,
  rss: 4_000,
})
const SUPERVISOR = series({ key: '$root', cpuMain: 1, cpuGc: 0, cpuLifetime: 1, rss: 100 })

const ALL: readonly LoadSeries[] = [PIPELINE, SUPERVISOR, BROKER]

const labelFor = (s: LoadSeries): string => (s.key === '$root' ? 'Node supervisor' : s.key)

function keysOf(out: readonly LoadSeries[]): readonly string[] {
  return out.map((s) => s.key)
}

const NO_FILTER = { search: '', selectedKeys: new Set<string>() } as const

describe('filterAndSortLoadCards — narrowing', () => {
  it('an EMPTY multiselect means all runners, never none', () => {
    // A surface that renders zero cards because a filter defaulted to empty
    // looks exactly like a node that stopped reporting.
    const out = filterAndSortLoadCards(ALL, { ...NO_FILTER, sort: DEFAULT_LOAD_SORT }, labelFor)
    expect(out).toHaveLength(3)
  })

  it('a selection NARROWS the rendered cards to the pinned runners', () => {
    const out = filterAndSortLoadCards(
      ALL,
      {
        search: '',
        selectedKeys: new Set(['runner:pipeline', '$root']),
        sort: DEFAULT_LOAD_SORT,
      },
      labelFor,
    )
    expect(keysOf(out)).toEqual(['runner:pipeline', '$root'])
  })

  it('search matches the DISPLAYED label, not only the internal key', () => {
    // `$root` renders as "Node supervisor"; searching for what is on screen
    // must find it.
    const out = filterAndSortLoadCards(
      ALL,
      { search: 'supervisor', selectedKeys: new Set(), sort: DEFAULT_LOAD_SORT },
      labelFor,
    )
    expect(keysOf(out)).toEqual(['$root'])
  })

  it('search also matches the key, and is case-insensitive', () => {
    const out = filterAndSortLoadCards(
      ALL,
      { search: 'STREAM-BROKER', selectedKeys: new Set(), sort: DEFAULT_LOAD_SORT },
      labelFor,
    )
    expect(keysOf(out)).toEqual(['runner:stream-broker'])
  })

  it('search and selection compose — both must pass', () => {
    const out = filterAndSortLoadCards(
      ALL,
      {
        search: 'pipeline',
        selectedKeys: new Set(['$root']),
        sort: DEFAULT_LOAD_SORT,
      },
      labelFor,
    )
    expect(out).toHaveLength(0)
  })
})

describe('filterAndSortLoadCards — ordering', () => {
  it('defaults to heaviest CPU first — the question this page is opened with', () => {
    expect(DEFAULT_LOAD_SORT).toEqual({ key: 'cpu', dir: 'desc' })
    const out = filterAndSortLoadCards(ALL, { ...NO_FILTER, sort: DEFAULT_LOAD_SORT }, labelFor)
    expect(keysOf(out)).toEqual(['runner:stream-broker', 'runner:pipeline', '$root'])
  })

  it('REORDERS when the sort key changes — memory is a different answer', () => {
    const sort: LoadSortState = { key: 'memory', dir: 'desc' }
    const out = filterAndSortLoadCards(ALL, { ...NO_FILTER, sort }, labelFor)
    expect(keysOf(out)).toEqual(['runner:pipeline', 'runner:stream-broker', '$root'])
  })

  it('reverses on direction', () => {
    const out = filterAndSortLoadCards(
      ALL,
      { ...NO_FILTER, sort: { key: 'cpu', dir: 'asc' } },
      labelFor,
    )
    expect(keysOf(out)).toEqual(['$root', 'runner:pipeline', 'runner:stream-broker'])
  })

  it('orders by the label for `name`, not by the raw key', () => {
    const out = filterAndSortLoadCards(
      ALL,
      { ...NO_FILTER, sort: { key: 'name', dir: 'asc' } },
      labelFor,
    )
    // "Node supervisor" sorts before "runner:…" by label; by KEY, `$root`
    // would also come first, so the discriminating case is the pair below.
    expect(keysOf(out)).toEqual(['$root', 'runner:pipeline', 'runner:stream-broker'])
  })

  it('does not mutate the input array', () => {
    const before = [...ALL]
    filterAndSortLoadCards(ALL, { ...NO_FILTER, sort: DEFAULT_LOAD_SORT }, labelFor)
    expect(ALL).toEqual(before)
  })
})

describe('the sorted values are the ones the card SHOWS', () => {
  it('CPU is the stacked total when the thread split exists', () => {
    expect(cardCpuValue(BROKER)).toBe(45)
  })

  it('CPU falls back to the lifetime average when the split does not', () => {
    const noSplit = series({
      key: 'runner:x',
      cpuMain: null,
      cpuGc: null,
      cpuLifetime: 22,
      rss: 10,
    })
    // That is exactly the number the card's readout prints in this case.
    expect(cardCpuValue(noSplit)).toBe(22)
  })

  it('an EMPTY series weighs null and sorts LAST in both directions', () => {
    // Never 0: a runner with no samples is unknown, and presenting unknown as
    // "idle" is the reading that sends someone hunting the wrong process.
    const empty: LoadSeries = { key: 'runner:silent', kind: 'addon', points: [] }
    expect(cardCpuValue(empty)).toBeNull()
    expect(cardMemoryValue(empty)).toBeNull()

    const withEmpty = [...ALL, empty]
    for (const dir of ['desc', 'asc'] as const) {
      const out = filterAndSortLoadCards(
        withEmpty,
        { ...NO_FILTER, sort: { key: 'cpu', dir } },
        labelFor,
      )
      expect(keysOf(out).at(-1), dir).toBe('runner:silent')
    }
  })
})
