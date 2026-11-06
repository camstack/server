/**
 * The off-catalog part of the Customize table, one row PER FIELD: a built device
 * lists the fields its caps carry, grouped by cap, each with a row state. A field
 * the stored composition has no entry for yet but the cap requires is a "to fill"
 * row. Clocks (`lastFetchedAt`) go under Advanced.
 */
import {
  classifyFieldSource,
  type CompositionCardFieldEntry,
  type CompositionFieldsCard,
  type CompositionFieldsFeature,
  compositionSourceKey,
} from '@camstack/types'
import { unfilledRequiredFields } from '../../../composition-editor/build-skeleton'
import { entryReads } from './extra-rows'

/** A field whose name ends in `At` is a clock the integration keeps, not something to bind. */
export function isClockField(path: string): boolean {
  return /At$/.test(path)
}

/** A companion clock, or a formula that reads no device: a constant, nothing to bind. */
function isConstantEntry(entry: CompositionCardFieldEntry): boolean {
  return (
    entry.kind === 'companion' ||
    (entry.kind === 'formula' && Object.keys(entry.bindings).length === 0)
  )
}

/** What the fleet says about one source device. */
export type SourcePresence = 'answering' | 'offline' | 'missing'

export type FieldRowState =
  | { readonly kind: 'toFill' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'bound' }
  | { readonly kind: 'notAnswering' }
  | { readonly kind: 'missing' }

export interface FieldRow {
  readonly key: string
  readonly cap: string
  readonly path: string
  /** null = nothing stored yet (a required field to fill). */
  readonly entry: CompositionCardFieldEntry | null
  readonly advanced: boolean
  /** Set on a keyed item's field (a consumable's level, status, remaining…): the item it belongs to. */
  readonly item: { readonly key: string; readonly label: string } | null
}

export interface FieldGroup {
  readonly cap: string
  readonly rows: readonly FieldRow[]
  readonly advanced: readonly FieldRow[]
}

/** One group per stored field card: required-but-empty fields first, then the stored ones. */
export function fieldGroups(cards: readonly CompositionFieldsCard[]): readonly FieldGroup[] {
  return cards.map((card) => {
    const filled = new Set(Object.keys(card.entries))
    const empty = unfilledRequiredFields(card.cap, filled).map(
      (path): FieldRow => ({
        key: `${card.cap}.${path}`,
        cap: card.cap,
        path,
        entry: null,
        advanced: isClockField(path),
        item: null,
      }),
    )
    const stored = Object.entries(card.entries).map(
      ([path, entry]): FieldRow => ({
        key: `${card.cap}.${path}`,
        cap: card.cap,
        path,
        entry,
        advanced: isClockField(path) || isConstantEntry(entry),
        item: null,
      }),
    )
    const all = [...empty, ...stored]
    return {
      cap: card.cap,
      rows: all.filter((row) => !row.advanced),
      advanced: all.filter((row) => row.advanced),
    }
  })
}

/**
 * The row state: a source the fleet no longer lists is missing, one that is offline
 * is not answering, and while the fleet is unread nothing is claimed either way (D315).
 */
export function fieldRowState(
  row: FieldRow,
  presence: ReadonlyMap<string, SourcePresence> | null,
): FieldRowState {
  if (row.entry === null) return { kind: 'toFill' }
  const reads = entryReads(row.entry)
  if (reads.length === 0) return { kind: 'bound' }
  if (presence === null) return { kind: 'checking' }
  const states = reads.map((read) => presence.get(compositionSourceKey(read.source)) ?? 'missing')
  if (states.includes('missing')) return { kind: 'missing' }
  if (states.includes('offline')) return { kind: 'notAnswering' }
  return { kind: 'bound' }
}

/**
 * A keyed item (a consumable) as a small form: one row per field the stored item
 * writes, each bound and judged like any other row.
 */
export function itemFieldRows(feature: CompositionFieldsFeature | null): readonly FieldRow[] {
  return Object.entries(feature?.items ?? {}).flatMap(([itemKey, item]) =>
    Object.entries(item.fields)
      // The item's kind/form/unit literals are not something to bind: they stay out of the form.
      .filter(([, source]) => {
        const entry = classifyFieldSource(source)
        return !isConstantEntry(entry)
      })
      .map(
        ([path, source]): FieldRow => ({
          key: `${feature?.cap ?? ''}.items[${itemKey}].${path}`,
          cap: feature?.cap ?? '',
          path,
          entry: classifyFieldSource(source),
          advanced: false,
          item: { key: itemKey, label: item.label },
        }),
      ),
  )
}
