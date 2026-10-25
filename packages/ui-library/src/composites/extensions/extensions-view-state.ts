/**
 * What the Extensions section may CLAIM, from what `listSlots` answered
 * (D648, D315).
 *
 * Four states, and the two a boolean would collapse are kept apart on purpose:
 *
 *  - `pending` — nobody has answered yet. Never "no extensions".
 *  - `unknown` — the query FAILED. It is not an answer, so it is not absence
 *    either; the reason is shown verbatim.
 *  - `none` — the query answered with nothing. The only state that may say
 *    "no extensions".
 *  - `rows` — cards, in the generated table's order, and every owner that
 *    could not answer as its own row with its reason (D554.4). A device whose
 *    ONLY owner failed is `rows` with no slots, not `none`.
 *
 * Also here, pure: the editor's draft rules, so the component holds no logic
 * a spec cannot reach.
 */
import {
  EXTENSION_SLOT_IDS,
  type ExtensionCandidate,
  type ExtensionSlotCardinality,
  type ExtensionSlotRow,
  type ExtensionSlotState,
  type ExtensionSlotUnreachable,
  type ExtensionSlotValue,
} from '@camstack/types'
import { defaultUiText, type UiTextFn } from '../../contexts/ui-text.js'

/** The one field of a query error this module reads. */
export interface ExtensionsQueryError {
  readonly message: string
}

/** The fields of a query result this module reads — nothing else. */
export interface ExtensionsQueryView {
  readonly status: 'pending' | 'error' | 'success'
  readonly data?: readonly ExtensionSlotRow[] | undefined
  readonly error?: ExtensionsQueryError | null
}

/** Nobody has answered yet. */
export interface ExtensionsPendingView {
  readonly kind: 'pending'
}

/** The read FAILED — not an answer, so not absence either. */
export interface ExtensionsUnknownView {
  readonly kind: 'unknown'
  readonly reason: string
}

/** Answered with nothing — the only state that may say "no extensions". */
export interface ExtensionsNoneView {
  readonly kind: 'none'
}

/**
 * A row of a slot this build does NOT declare — an older or newer server than
 * this admin UI (a rollback after slice 6 still answers `doorbell-source`).
 * It cannot be a card (no descriptor), so it is said by name instead: never
 * dropped, never crashing the panel (D315, task 17 re-review R1).
 */
export interface ExtensionsUnknownSlotRow {
  readonly slot: string
  readonly slotRef: string
}

/** Cards in table order, every slot this build does not know, and every owner that could not answer. */
export interface ExtensionsRowsView {
  readonly kind: 'rows'
  readonly slots: readonly ExtensionSlotState[]
  readonly unknownSlots: readonly ExtensionsUnknownSlotRow[]
  readonly unreachable: readonly ExtensionSlotUnreachable[]
}

export type ExtensionsView =
  | ExtensionsPendingView
  | ExtensionsUnknownView
  | ExtensionsNoneView
  | ExtensionsRowsView

/** The order cards are shown in: the generated slot table's. */
export type ExtensionSlotTableOrder = readonly string[]

/**
 * Whether the WIRE row's slot is one this build declares. The tRPC client does
 * not validate output, so a row's `slot` can be any string at runtime even
 * though its type says otherwise; the comparison runs on the string.
 */
function isDeclaredSlotRow(row: ExtensionSlotState, order: ExtensionSlotTableOrder): boolean {
  const slot: string = row.slot
  return order.some((id) => id === slot)
}

/**
 * `order` is the generated table (`EXTENSION_SLOT_IDS`); a parameter only so a
 * spec can pin the comparator while the table holds a single slot.
 */
export function resolveExtensionsView(
  query: ExtensionsQueryView,
  order: ExtensionSlotTableOrder = EXTENSION_SLOT_IDS,
  t: UiTextFn = defaultUiText,
): ExtensionsView {
  const tableOrder = (slot: ExtensionSlotState['slot']): number => order.indexOf(slot)
  if (query.status === 'pending') return { kind: 'pending' }
  if (query.status === 'error') {
    return {
      kind: 'unknown',
      reason: query.error?.message ?? t('uiLibrary.extensions.requestFailed', 'the request failed'),
    }
  }
  const rows = query.data ?? []
  if (rows.length === 0) return { kind: 'none' }
  const slots: ExtensionSlotState[] = []
  const unknownSlots: ExtensionsUnknownSlotRow[] = []
  const unreachable: ExtensionSlotUnreachable[] = []
  for (const row of rows) {
    if (row.state !== 'ok') unreachable.push(row)
    else if (isDeclaredSlotRow(row, order)) slots.push(row)
    else unknownSlots.push({ slot: row.slot, slotRef: row.slotRef })
  }
  return {
    kind: 'rows',
    slots: slots.toSorted((a, b) => tableOrder(a.slot) - tableOrder(b.slot)),
    unknownSlots,
    unreachable,
  }
}

/** Add or remove one pick. `one` replaces; `many` toggles. */
export function togglePick(
  draft: readonly number[],
  deviceId: number,
  cardinality: ExtensionSlotCardinality,
): readonly number[] {
  if (draft.includes(deviceId)) return draft.filter((id) => id !== deviceId)
  return cardinality === 'one' ? [deviceId] : [...draft, deviceId]
}

/** Suggested candidates the operator has NOT picked — shown to confirm, never saved on their own (D356). */
export function pendingSuggestions(
  candidates: readonly ExtensionCandidate[],
  draft: readonly number[],
): readonly ExtensionCandidate[] {
  return candidates.filter((c) => c.suggested && !draft.includes(c.deviceId))
}

/** Candidates matching a free-text search, not already picked. */
export function searchCandidates(
  candidates: readonly ExtensionCandidate[],
  draft: readonly number[],
  query: string,
): readonly ExtensionCandidate[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return []
  return candidates.filter(
    (c) =>
      !draft.includes(c.deviceId) &&
      [c.name, c.location ?? '', c.parentName ?? '', c.type].some((v) =>
        v.toLowerCase().includes(needle),
      ),
  )
}

/** Whether the draft differs from what the owner's store holds. */
export function isDirty(saved: readonly number[], draft: readonly number[]): boolean {
  return saved.length !== draft.length || saved.some((id, i) => draft[i] !== id)
}

/**
 * The tracked-event opt-in a slot's value carries, or `undefined` when it
 * carries none — every slot but `linked-devices`, and a `linked-devices` row
 * from a server older than D655. `undefined` is "this owner offers no
 * opt-in", never "nothing is opted in": the card then shows no toggle rather
 * than a row of unticked ones it could not save.
 */
export function trackedOptInOf(value: ExtensionSlotValue): readonly number[] | undefined {
  return value.slot === 'linked-devices' ? value.trackedDeviceIds : undefined
}

/** Flip one device's tracked-event opt-in. */
export function toggleTracked(tracked: readonly number[], deviceId: number): readonly number[] {
  return tracked.includes(deviceId)
    ? tracked.filter((id) => id !== deviceId)
    : [...tracked, deviceId]
}

/** Whether two opt-ins differ as SETS — the order carries no meaning. */
export function isTrackedDirty(saved: readonly number[], draft: readonly number[]): boolean {
  return saved.length !== draft.length || saved.some((id) => !draft.includes(id))
}

/** Where a tracked-event toggle comes from — said next to it. */
export type TrackedOptionOrigin = 'pick' | 'implied' | 'not-linked'

/** One device the editor offers a tracked-event toggle for. */
export interface TrackedOption {
  readonly deviceId: number
  readonly origin: TrackedOptionOrigin
}

/** What `trackedOptions` builds the toggle list from. */
export interface TrackedOptionsInput {
  /** The draft picks. */
  readonly picks: readonly number[]
  /** Saved picks that are not a valid source (a container, D356) — no toggle. */
  readonly invalidPicks: readonly number[]
  /** Linked by the owner's own structure (`impliedSources`). */
  readonly implied: readonly number[]
  /** The draft opt-in. */
  readonly tracked: readonly number[]
}

/**
 * One toggle per device the camera links — the old section's set (D655):
 * the valid picks, then what the owner links by structure (tree children, a
 * picked container's child — never the container itself, D356), then every
 * opted-in device that is linked no more, so a stored opt-in is always
 * visible and can always be removed.
 */
export function trackedOptions(input: TrackedOptionsInput): readonly TrackedOption[] {
  const out: TrackedOption[] = []
  const seen = new Set<number>()
  const add = (deviceId: number, origin: TrackedOptionOrigin): void => {
    if (seen.has(deviceId)) return
    seen.add(deviceId)
    out.push({ deviceId, origin })
  }
  for (const id of input.picks) if (!input.invalidPicks.includes(id)) add(id, 'pick')
  for (const id of input.implied) add(id, 'implied')
  for (const id of input.tracked) add(id, 'not-linked')
  return out
}

/**
 * The opt-in after one device is removed from the draft picks: its toggle
 * goes with it, unless the camera still links it by structure.
 */
export function untrackUnpicked(
  tracked: readonly number[],
  deviceId: number,
  implied: readonly number[],
): readonly number[] {
  return implied.includes(deviceId) ? tracked : tracked.filter((id) => id !== deviceId)
}

/**
 * The value a Save sends. The opt-in travels only when the owner offered one,
 * and then WHOLE: it replaces the stored one, and the owner accepts any id it
 * already stored, so what was read can be sent back unchanged (D655).
 */
export function slotWriteValue(
  saved: ExtensionSlotValue,
  deviceIds: readonly number[],
  tracked: readonly number[] | undefined,
): ExtensionSlotValue {
  if (saved.slot === 'linked-devices' && tracked !== undefined) {
    return { slot: 'linked-devices', deviceIds: [...deviceIds], trackedDeviceIds: [...tracked] }
  }
  return { slot: saved.slot, deviceIds: [...deviceIds] }
}
