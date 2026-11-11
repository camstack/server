/**
 * The condition kind picker's model: which row kinds a place may add, how a
 * search narrows and ranks them, how they group, and why one is disabled.
 *
 * Framework-free: no React, no DOM, no i18n. The caller resolves the texts
 * (`textsOf`, `categoryLabelOf`) so the same model serves the admin modal and a
 * phone sheet. The kinds themselves come from `AUTOMATION_LEAF_CATALOG` — this
 * file lists none.
 */
import {
  AUTOMATION_LEAF_CATEGORIES,
  type AutomationLeafCategory,
  type AutomationLeafContext,
  type AutomationLeafKind,
  type AutomationLeafRole,
  leafCatalogEntry,
  leafKindsFor,
} from '@camstack/types'

/** The resolved texts of one kind, in the viewer's language. */
export interface KindTexts {
  readonly label: string
  readonly description: string
  readonly example: string
}

/** Why a kind is shown but cannot be picked here. */
export type KindDisabledReason = 'event-in-guard' | 'event-under-not' | 'tree-full'

export interface KindPickerItem extends KindTexts {
  readonly kind: AutomationLeafKind
  readonly category: AutomationLeafCategory
  readonly role: AutomationLeafRole
  readonly needsDeviceValue: boolean
  readonly disabled: KindDisabledReason | null
}

export interface KindPickerGroup {
  readonly category: AutomationLeafCategory
  readonly label: string
  readonly count: number
  readonly items: readonly KindPickerItem[]
}

export interface KindPickerInput {
  readonly context: AutomationLeafContext
  readonly query: string
  readonly textsOf: (kind: AutomationLeafKind) => KindTexts
  readonly categoryLabelOf: (category: AutomationLeafCategory) => string
  /** The row sits under a NOT: an instant cannot be negated. */
  readonly underNot: boolean
  /** Adding a row to a tree already at its row bound. False when CHANGING a row's type. */
  readonly treeFull: boolean
  /** The operator's last picks, newest first. */
  readonly recent: readonly AutomationLeafKind[]
  /** Kinds the surrounding page suggests (a camera page suggests detection). */
  readonly suggested: readonly AutomationLeafKind[]
}

export interface KindPickerView {
  /** Shown above the groups while the search is empty. */
  readonly suggested: readonly KindPickerItem[]
  readonly recent: readonly KindPickerItem[]
  readonly groups: readonly KindPickerGroup[]
  /** What Enter picks: the best match that is not disabled, or nothing. */
  readonly firstEnabled: AutomationLeafKind | null
}

/** How many recent kinds are kept and shown. */
export const RECENT_KIND_LIMIT = 4

const SCORE_LABEL_PREFIX = 4
const SCORE_LABEL = 3
const SCORE_KEYWORD = 2
const SCORE_SMALL_PRINT = 1

function disabledReason(
  role: AutomationLeafRole,
  allowed: boolean,
  input: KindPickerInput,
): KindDisabledReason | null {
  if (input.treeFull) return 'tree-full'
  if (role === 'event' && !allowed) return 'event-in-guard'
  if (role === 'event' && input.underNot) return 'event-under-not'
  return null
}

function itemOf(kind: AutomationLeafKind, input: KindPickerInput): KindPickerItem {
  const entry = leafCatalogEntry(kind)
  const allowed = entry.allowedIn.includes(input.context)
  return {
    kind,
    category: entry.category,
    role: entry.role,
    needsDeviceValue: entry.needsDeviceValue,
    disabled: disabledReason(entry.role, allowed, input),
    ...input.textsOf(kind),
  }
}

/** How well ONE word matches an item; 0 = not at all. */
function wordScore(word: string, item: KindPickerItem, categoryLabel: string): number {
  const label = item.label.toLowerCase()
  if (label.startsWith(word)) return SCORE_LABEL_PREFIX
  if (label.includes(word)) return SCORE_LABEL
  if (leafCatalogEntry(item.kind).keywords.some((k) => k.includes(word))) return SCORE_KEYWORD
  const smallPrint = `${item.description} ${item.example} ${categoryLabel}`.toLowerCase()
  return smallPrint.includes(word) ? SCORE_SMALL_PRINT : 0
}

/** Every word must match somewhere; the score is the sum. 0 = filtered out. */
function queryScore(words: readonly string[], item: KindPickerItem, categoryLabel: string): number {
  let total = 0
  for (const word of words) {
    const score = wordScore(word, item, categoryLabel)
    if (score === 0) return 0
    total += score
  }
  return total
}

function uniqueKinds(kinds: readonly AutomationLeafKind[]): readonly AutomationLeafKind[] {
  return kinds.filter((kind, index) => kinds.indexOf(kind) === index)
}

export function buildKindPicker(input: KindPickerInput): KindPickerView {
  const words = input.query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0)
  const searching = words.length > 0
  // Every kind is offered, the ones this place cannot take disabled with the
  // reason: a kind that silently vanishes reads as "it does not exist".
  const scored = leafKindsFor('any')
    .map((kind) => {
      const item = itemOf(kind, input)
      const score = searching ? queryScore(words, item, input.categoryLabelOf(item.category)) : 1
      return { item, score }
    })
    .filter((entry) => entry.score > 0)

  const groups = AUTOMATION_LEAF_CATEGORIES.map((category): KindPickerGroup => {
    const items = scored.filter((e) => e.item.category === category).map((e) => e.item)
    return { category, label: input.categoryLabelOf(category), count: items.length, items }
  }).filter((group) => group.count > 0)

  // Stable sort: equal scores keep the catalogue's order.
  const best = [...scored]
    .sort((a, b) => b.score - a.score)
    .find((entry) => entry.item.disabled === null)

  const suggestedKinds = searching ? [] : uniqueKinds(input.suggested)
  const recentKinds = searching
    ? []
    : uniqueKinds(input.recent)
        .filter((kind) => !suggestedKinds.includes(kind))
        .slice(0, RECENT_KIND_LIMIT)

  return {
    suggested: suggestedKinds.map((kind) => itemOf(kind, input)),
    recent: recentKinds.map((kind) => itemOf(kind, input)),
    groups,
    firstEnabled: best?.item.kind ?? null,
  }
}

/** The recent list after a pick: newest first, once, bounded. */
export function rememberRecentKind(
  recent: readonly AutomationLeafKind[],
  picked: AutomationLeafKind,
): readonly AutomationLeafKind[] {
  return uniqueKinds([picked, ...recent]).slice(0, RECENT_KIND_LIMIT)
}
