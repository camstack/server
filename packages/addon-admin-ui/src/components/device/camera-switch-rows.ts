/**
 * The per-camera FUNCTION SWITCHES, as the hub composes them (D544).
 *
 * ## Why this replaced a local list
 *
 * `pipelineOrchestrator.getCameraSwitches` builds every row from
 * `CAMERA_SWITCH_CATALOG` — id, label, cost line, availability, state — and
 * the viewer has always rendered exactly that. The admin UI instead
 * re-derived FOUR of the nine from `getBindings` +
 * `recording.getDeviceConfig`, against a hand-written list of ids, so
 * `privacy-mask`, `device-audio`, `broker-audio`, `stream-broker` and
 * `notifications` did not exist on this surface at all. The operator found it
 * the obvious way: the mask control is on the viewer and not in device
 * details.
 *
 * Two derivations of one catalog do not stay in step. These did not.
 *
 * ## Icons are decoration, never a second catalog
 *
 * {@link iconKeyForLabel} guesses from the LABEL, not the id. The viewer
 * guards its own source against branching on a switch id, and an id-keyed
 * icon map is precisely that guard's target: the moment a file enumerates
 * ids, the next switch the hub adds renders wrong — or not at all — and
 * nobody finds out until an operator reports a function they cannot turn off.
 * A label this file does not recognise still renders a complete, working
 * control with the generic glyph.
 *
 * Pure: no React, no hooks, no network. The component supplies the payload.
 */

import i18n from '../../i18n/index'

/** One switch, as this surface needs it. */
export interface CameraSwitchRow {
  readonly id: string
  readonly label: string
  /** What the operator loses while it is off — the control's title. */
  readonly costWhenOff: string
  /** `null` = the authority did not answer. Never coerced to a boolean. */
  readonly on: boolean | null
  /** A control is only offered when its state is known AND writable. */
  readonly available: boolean
  /** Why it is unavailable, when the hub said. Shown instead of a toggle. */
  readonly unavailableReason: string | null
}

function readRow(value: unknown): CameraSwitchRow | null {
  if (typeof value !== 'object' || value === null) return null
  const rec = value as Record<string, unknown>
  const id = rec['id']
  const label = rec['label']
  if (typeof id !== 'string' || typeof label !== 'string') return null
  const available = rec['available'] === true
  const enabled = rec['enabled']
  const reason = rec['unavailableReason']
  return {
    id,
    label,
    costWhenOff: typeof rec['costWhenOff'] === 'string' ? rec['costWhenOff'] : '',
    // An unavailable row has no truthful ON/OFF to report: the hub could not
    // read its authority. `null` draws as unknown, and unknown is never
    // counted as "the operator switched this off" (D113's surviving half).
    on: available && typeof enabled === 'boolean' ? enabled : null,
    available,
    unavailableReason: typeof reason === 'string' ? reason : null,
  }
}

/**
 * Read `getCameraSwitches`'s answer.
 *
 * `null` for anything unreadable — NOT an empty list. An empty list is the
 * claim "this camera has no functions", and a query that has not answered may
 * not make a claim (D315).
 */
export function parseCameraSwitchRows(value: unknown): readonly CameraSwitchRow[] | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = (value as Record<string, unknown>)['switches']
  if (!Array.isArray(raw)) return null
  const rows = raw.map(readRow).filter((r): r is CameraSwitchRow => r !== null)
  return rows.length === 0 ? null : rows
}

/** The glyph families this surface draws. Decoration only. */
export type CameraSwitchIconKey =
  | 'stream'
  | 'detection'
  | 'privacy'
  | 'microphone'
  | 'speaker'
  | 'listening'
  | 'archive'
  | 'recording'
  | 'notifications'
  | 'generic'

/**
 * Ordered, first match wins. `Camera microphone` must reach `microphone`
 * before the broader audio rule, and `Audio analysis` must not be captured by
 * the stream rule.
 */
const ICON_RULES: readonly (readonly [RegExp, CameraSwitchIconKey])[] = [
  [/privacy|mask/i, 'privacy'],
  [/microphone|mic\b/i, 'microphone'],
  [/speaker|broker audio|stream audio/i, 'speaker'],
  [/audio/i, 'listening'],
  [/object|detect/i, 'detection'],
  [/event/i, 'archive'],
  [/record/i, 'recording'],
  [/notif/i, 'notifications'],
  [/stream|broker/i, 'stream'],
]

export function iconKeyForLabel(label: string): CameraSwitchIconKey {
  for (const [pattern, key] of ICON_RULES) {
    if (pattern.test(label)) return key
  }
  return 'generic'
}

export interface CameraSwitchSummary {
  /** Functions the operator switched OFF. Never includes an unknown. */
  readonly offIds: readonly string[]
  /** Functions whose authority did not answer. Never counted as off. */
  readonly unknownIds: readonly string[]
  /** One line for the trigger's tooltip and its visible badge. */
  readonly summary: string
}

/**
 * Carry the OFF report OUT of the collapsed control.
 *
 * **An off function is REPORTED off** — that badge is the difference between
 * "somebody switched this camera off" and "this camera is broken", and folding
 * the controls behind one trigger would erase it. `unknownIds` is separate and
 * never merged in: a trigger badging `1 off` because a read failed is the same
 * false claim, made smaller.
 */
export function summariseCameraSwitches(rows: readonly CameraSwitchRow[]): CameraSwitchSummary {
  const offIds = rows.filter((r) => r.on === false).map((r) => r.id)
  const unknownIds = rows.filter((r) => r.on === null).map((r) => r.id)
  const labelsOf = (ids: readonly string[]): string =>
    ids.map((id) => rows.find((r) => r.id === id)?.label ?? id).join(', ')
  const parts: string[] = []
  if (offIds.length > 0)
    parts.push(i18n.t('helpers.cameraSwitchRows.off', { list: labelsOf(offIds) }))
  if (unknownIds.length > 0)
    parts.push(i18n.t('helpers.cameraSwitchRows.unknown', { list: labelsOf(unknownIds) }))
  return {
    offIds,
    unknownIds,
    summary: parts.length === 0 ? i18n.t('helpers.cameraSwitchRows.allOn') : parts.join(' · '),
  }
}
