/**
 * Finding one runner's charts on the Load tab — search, filter and order, as
 * pure functions.
 *
 * The tab renders an unbounded stack of per-runner chart cards. On a hub with
 * a dozen runners the card you want is somewhere below the fold and there was
 * no way to ask for it.
 *
 * ## The rule these functions exist to keep
 *
 * **Every sort key names a number the card actually SHOWS.** A card shows two
 * things: the CPU readout (main + V8 pool, or the lifetime average when the
 * thread split is unavailable) and the memory readout. Plus its name. That is
 * the whole list of legitimate orderings — this repo's tables encode the same
 * rule by omitting `sortValue` on a column that has no single value, and a
 * control that offers "sort by uptime" on a card with no uptime on it would be
 * an ordering the operator cannot verify by looking.
 *
 * ## Absent is not zero, here either
 *
 * A series whose newest sample is unknown weighs `null`, and `null` sorts LAST
 * in both directions rather than being coerced to 0. A runner that stopped
 * reporting must not be presented as the idlest one on the node.
 */
import type { LoadSeries } from './load-series'

/** The orderings a Load card can honestly offer. */
export type LoadSortKey = 'cpu' | 'memory' | 'name'

export type LoadSortDir = 'asc' | 'desc'

export interface LoadSortState {
  readonly key: LoadSortKey
  readonly dir: LoadSortDir
}

/**
 * Opening order: heaviest CPU first.
 *
 * The operator opens this tab to answer "what is eating this machine", and the
 * answer is at the top before anything is clicked. Memory-first would answer a
 * question that is asked less often and, on a Node process, is mostly a
 * function of heap high-water rather than of current work.
 */
export const DEFAULT_LOAD_SORT: LoadSortState = { key: 'cpu', dir: 'desc' }

export interface LoadCardFilter {
  /** Free text over the card's displayed label. Empty = no narrowing. */
  readonly search: string
  /**
   * Runner keys to keep. EMPTY MEANS ALL — an empty multiselect is "I have not
   * chosen", never "show me nothing". A surface that renders zero cards
   * because a filter defaulted to empty looks exactly like a broken node.
   */
  readonly selectedKeys: ReadonlySet<string>
  readonly sort: LoadSortState
}

/**
 * The CPU number the card displays: the stacked total, or the lifetime average
 * when this node has no thread split. `null` when the newest sample knows
 * neither — the card shows nothing there, so nothing may be sorted by.
 */
export function cardCpuValue(series: LoadSeries): number | null {
  const last = series.points.at(-1)
  if (last === undefined) return null
  if (last.cpuMainPercent !== null && last.cpuGcPercent !== null) {
    return last.cpuMainPercent + last.cpuGcPercent
  }
  return last.cpuLifetimePercent
}

/** The memory number the card displays. `null` when the newest sample has none. */
export function cardMemoryValue(series: LoadSeries): number | null {
  return series.points.at(-1)?.memoryRssBytes ?? null
}

/** Case-insensitive substring match over the label the operator can see. */
function matchesSearch(label: string, key: string, search: string): boolean {
  const needle = search.trim().toLowerCase()
  if (needle === '') return true
  return label.toLowerCase().includes(needle) || key.toLowerCase().includes(needle)
}

/** The value a numeric sort key reads off a card. */
function cardValue(series: LoadSeries, key: LoadSortKey): number | null {
  return key === 'memory' ? cardMemoryValue(series) : cardCpuValue(series)
}

/**
 * Narrow and order the cards. Pure — returns a new array, never sorts in place.
 *
 * `labelFor` is passed in rather than imported because the label is an i18n
 * lookup owned by the component; search must match what is on screen, not an
 * internal key the operator never sees. (The key is matched too — an operator
 * who knows a runner id should not be punished for typing it.)
 */
export function filterAndSortLoadCards(
  series: readonly LoadSeries[],
  filter: LoadCardFilter,
  labelFor: (series: LoadSeries) => string,
): readonly LoadSeries[] {
  const kept = series.filter((s) => {
    if (filter.selectedKeys.size > 0 && !filter.selectedKeys.has(s.key)) return false
    return matchesSearch(labelFor(s), s.key, filter.search)
  })

  // Stable tiebreak on the key, so equal load never reorders between renders.
  const tiebreak = (a: LoadSeries, b: LoadSeries): number => a.key.localeCompare(b.key)

  return [...kept].toSorted((a, b) => {
    if (filter.sort.key === 'name') {
      const d = labelFor(a).localeCompare(labelFor(b))
      const directed = filter.sort.dir === 'asc' ? d : -d
      return directed !== 0 ? directed : tiebreak(a, b)
    }

    const va = cardValue(a, filter.sort.key)
    const vb = cardValue(b, filter.sort.key)
    // Unknown sorts LAST in BOTH directions — outside the direction flip, not
    // inside it. Negating a "null is bigger" comparison to get ascending order
    // puts the runners that stopped reporting at the TOP of "least loaded",
    // which is the reading that sends someone hunting the wrong process.
    if (va === null && vb === null) return tiebreak(a, b)
    if (va === null) return 1
    if (vb === null) return -1

    const d = filter.sort.dir === 'desc' ? vb - va : va - vb
    return d !== 0 ? d : tiebreak(a, b)
  })
}
