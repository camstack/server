/**
 * Plain term-overlap ranking for `ui:find`. No index, no dependency: the
 * catalogue is ~600 entries and a need is a handful of words.
 */
import type { CatalogueEntry, NeedRow } from './ui-catalogue.js'

const STOP = new Set([
  'a',
  'an',
  'the',
  'of',
  'to',
  'for',
  'with',
  'and',
  'or',
  'in',
  'on',
  'i',
  'need',
  'want',
  'that',
  'is',
  'it',
  'my',
])

/** Synonyms an author types for the words the code uses. */
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  modal: ['dialog', 'sheet'],
  popup: ['dialog', 'popover'],
  dialog: ['modal'],
  confirm: ['confirm', 'dialog'],
  delete: ['confirm', 'destructive', 'danger'],
  remove: ['confirm', 'destructive'],
  list: ['table', 'list'],
  grid: ['table', 'grid'],
  table: ['table', 'datatable'],
  dropdown: ['select', 'dropdown', 'menu'],
  select: ['select', 'picker'],
  picker: ['picker', 'select'],
  password: ['password', 'secret'],
  secret: ['secret', 'password'],
  token: ['secret'],
  toggle: ['switch', 'toggle'],
  tabs: ['tabs', 'tab'],
  spinner: ['skeleton', 'loading'],
  loading: ['skeleton', 'loading'],
  error: ['error', 'errorbox'],
  empty: ['empty', 'emptystate'],
  badge: ['badge', 'status'],
  node: ['node', 'nodepicker'],
  camera: ['device', 'camera'],
  device: ['device'],
  filter: ['filter', 'facet', 'search'],
  search: ['search', 'filter'],
  menu: ['menu', 'kebab', 'dropdown'],
}

export function terms(text: string): string[] {
  const split = text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
  const out = new Set<string>()
  for (const t of split) {
    out.add(t)
    if (t.endsWith('s') && t.length > 3) out.add(t.slice(0, -1))
    for (const alias of ALIASES[t] ?? []) out.add(alias)
  }
  return [...out]
}

function score(query: readonly string[], fields: readonly (readonly [string, number])[]): number {
  let total = 0
  for (const [text, weight] of fields) {
    const hay = terms(text)
    for (const q of query) {
      if (hay.includes(q)) total += weight
      else if (hay.some((h) => h.startsWith(q) && q.length >= 4)) total += weight / 2
    }
  }
  return total
}

const KIND_BONUS: Readonly<Record<string, number>> = {
  component: 1.5,
  hook: 1,
  function: 0,
  constant: 0,
}

export function rankEntries(entries: readonly CatalogueEntry[], query: string): CatalogueEntry[] {
  const q = terms(query)
  return entries
    .map((e) => {
      const s = score(q, [
        [e.name, 4],
        [e.summary, 1],
        [(e.props ?? []).map((p) => p.name).join(' '), 0.5],
      ])
      return { e, s: s > 0 ? s + (KIND_BONUS[e.kind] ?? 0) : 0 }
    })
    .filter((x) => x.s > 0)
    .toSorted((a, b) => b.s - a.s || a.e.name.localeCompare(b.e.name))
    .map((x) => x.e)
}

export function rankNeeds(needs: readonly NeedRow[], query: string): NeedRow[] {
  const q = terms(query)
  return needs
    .map((n) => ({
      n,
      s: score(q, [
        [n.need, 3],
        [`${n.admin} ${n.viewer}`, 1],
        [n.notes, 0.5],
      ]),
    }))
    .filter((x) => x.s > 0)
    .toSorted((a, b) => b.s - a.s)
    .map((x) => x.n)
}
