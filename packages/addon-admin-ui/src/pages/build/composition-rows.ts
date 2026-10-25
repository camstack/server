/**
 * How a stored composition becomes a row on `/build` → Custom Device.
 *
 * Two lists, split by what the composition TARGETS (D659, D663):
 *   - **Composed devices** — `target.kind === 'new'`: the block declares a device
 *     of its own, and the block's name IS that device's name;
 *   - **Customizations** — `target.kind === 'existing'`: one block per device,
 *     adding or replacing fields of a device that already exists. Listed for
 *     reference; it is edited from the device (slice 5).
 *
 * Pure, so the rules are tested without mounting the tab. Two things it must
 * never do:
 *
 *   - **Say a source is missing before the device list has answered** (D315).
 *     A source is `present`, `missing` (the list answered and holds no such
 *     `(addonId, stableId)`) or `unknown` (the list has not answered, or
 *     failed). `missing` is only ever built from an answered list.
 *   - **Say a block runs when it does not, or fails without a reason** (D391).
 *     The composer's own report wins; when the composer could not be asked the
 *     state is `Unknown` and names why, rather than falling back to a stored
 *     status that may be minutes old.
 */

import {
  type CompositionBlockState,
  type CompositionFieldSource,
  type CompositionSourceRef,
  type CompositionView,
  composedDeviceRef,
  compositionSourceKey,
  fieldReads,
} from '@camstack/types'
import type { BlockTone } from './core-block-status'
import i18n from '../../i18n/index'

/** The fields of a device row this module reads. */
export interface FleetDevice {
  readonly id: number
  readonly addonId: string
  readonly stableId: string
  readonly name: string
  readonly type: string
}

/**
 * The device list, as the tab holds it. `unanswered` covers pending AND
 * failed: in both cases nobody knows whether a device exists.
 */
export type FleetLookup =
  | { readonly state: 'answered'; readonly byRef: ReadonlyMap<string, FleetDevice> }
  | { readonly state: 'unanswered'; readonly reason: string }

export type SourcePresence = 'present' | 'missing' | 'unknown'

export interface CompositionRowSource {
  readonly key: string
  readonly label: string
  readonly presence: SourcePresence
  readonly deviceId: number | null
}

export interface CompositionRowState {
  readonly tone: BlockTone
  readonly label: string
  /** Never null for a row that should be running and is not. */
  readonly reason: string | null
}

export type CompositionRowKind = 'composed' | 'customization'

export interface CompositionRow {
  readonly blockId: string
  readonly kind: CompositionRowKind
  /** The composed device's name, or the customized device's name. */
  readonly name: string
  /** Whether `name` came from a device row that exists (`missing` = target gone). */
  readonly namePresence: SourcePresence
  /** Device type, or null while the target's row is not known. */
  readonly type: string | null
  /** The capabilities the composition composes, `(off)` when a feature is disabled. */
  readonly features: readonly string[]
  readonly state: CompositionRowState
  readonly sources: readonly CompositionRowSource[]
  /**
   * The COMPOSER's own answered device id — never resolved from the fleet.
   * A customization's `/devices/<id>?tab=customize` link is built ONLY from
   * this: while the composer has not answered (or holds no record of the
   * block), there is no link, even when the fleet already knows the target
   * device — that would be a link built from a guess (D315).
   */
  readonly reportedDeviceId: number | null
}

export interface CompositionRowLists {
  readonly composed: readonly CompositionRow[]
  readonly customizations: readonly CompositionRow[]
}

export function fleetLookupOf(devices: readonly FleetDevice[]): FleetLookup {
  return {
    state: 'answered',
    byRef: new Map(devices.map((device) => [compositionSourceKey(device), device] as const)),
  }
}

function lookup(fleet: FleetLookup, ref: CompositionSourceRef): FleetDevice | null | undefined {
  if (fleet.state === 'unanswered') return undefined
  return fleet.byRef.get(compositionSourceKey(ref)) ?? null
}

function presenceOf(found: FleetDevice | null | undefined): SourcePresence {
  if (found === undefined) return 'unknown'
  return found === null ? 'missing' : 'present'
}

function sourcesOfField(source: CompositionFieldSource): CompositionSourceRef[] {
  return fieldReads(source).map((read) => read.source)
}

/** Every device a composition reads, once each, in first-seen order. */
export function compositionSourceRefs(view: CompositionView): CompositionSourceRef[] {
  const composition =
    view.block.source?.kind === 'composition' ? view.block.source.composition : null
  if (composition === null) return []
  const refs: CompositionSourceRef[] = []
  for (const feature of composition.features) {
    if (feature.kind === 'passthrough') {
      refs.push(feature.source)
      continue
    }
    for (const field of Object.values(feature.fields)) refs.push(...sourcesOfField(field))
    for (const item of Object.values(feature.items ?? {})) {
      for (const field of Object.values(item.fields)) refs.push(...sourcesOfField(field))
    }
  }
  const seen = new Set<string>()
  return refs.filter((ref) => {
    const key = compositionSourceKey(ref)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * A block that RUNS can still produce nothing on some field (D391: accepting
 * work and producing nothing is the same branch as dropping it). Live, camera
 * 101's customization ran with `doorbell.pressCountSinceStart` unavailable and
 * the row read a plain green Running.
 */
function describeRunningFields(state: CompositionBlockState): CompositionRowState {
  const unavailable = state.fields.filter((field) => field.state === 'unavailable')
  const stale = state.fields.filter((field) => field.state === 'stale')
  if (unavailable.length === 0 && stale.length === 0) {
    return { tone: 'ok', label: i18n.t('helpers.compositionRows.running'), reason: null }
  }
  const counts = [
    ...(unavailable.length > 0
      ? [i18n.t('helpers.compositionRows.fieldsUnavailable', { count: unavailable.length })]
      : []),
    ...(stale.length > 0
      ? [i18n.t('helpers.compositionRows.fieldsStale', { count: stale.length })]
      : []),
  ].join(', ')
  const first = unavailable[0] ?? stale[0]
  const detail =
    first === undefined
      ? ''
      : ` — ${first.cap}.${first.path}: ${first.reason ?? i18n.t('helpers.compositionRows.noReason')}`
  return {
    tone: 'pending',
    label: i18n.t('helpers.compositionRows.running'),
    reason: `${counts}${detail}`,
  }
}

function describeRunStatus(
  state: CompositionBlockState,
  lastError: string | undefined,
): CompositionRowState {
  const reason = state.reason ?? lastError ?? null
  switch (state.status) {
    case 'running':
      return describeRunningFields(state)
    case 'degraded':
      return {
        tone: 'pending',
        label: i18n.t('helpers.compositionRows.degraded'),
        reason: reason ?? i18n.t('helpers.compositionRows.degradedReason'),
      }
    case 'starting':
      return { tone: 'pending', label: i18n.t('helpers.compositionRows.starting'), reason }
    case 'failed':
      return {
        tone: 'error',
        label: i18n.t('helpers.compositionRows.failed'),
        reason: reason ?? i18n.t('helpers.compositionRows.failedReason'),
      }
    default:
      return {
        tone: 'error',
        label: i18n.t('helpers.compositionRows.notRunning'),
        reason: reason ?? i18n.t('helpers.compositionRows.notRunningReason'),
      }
  }
}

/**
 * running / failed WITH its reason / off — from the composer's own report.
 * `Unknown` when the composer could not be asked: a stored status would be a
 * guess dressed as an answer.
 */
export function describeCompositionState(view: CompositionView): CompositionRowState {
  const { block, state } = view
  if (!block.enabled)
    return { tone: 'idle', label: i18n.t('helpers.compositionRows.off'), reason: null }
  if (state.kind === 'unreachable') {
    return {
      tone: 'pending',
      label: i18n.t('helpers.compositionRows.unknown'),
      reason: i18n.t('helpers.compositionRows.unreachable', { error: state.error }),
    }
  }
  if (state.state !== null) return describeRunStatus(state.state, block.lastError)
  // Answered, but the composer holds no record of this block. The stored
  // status is NOT an answer — a green Running built from it would be
  // not-yet-known dressed as known-good (D315) — so it is only quoted.
  const stored =
    block.lastError === undefined ? block.status : `${block.status}: ${block.lastError}`
  return {
    tone: 'pending',
    label: i18n.t('helpers.compositionRows.notReported'),
    reason: i18n.t('helpers.compositionRows.noRecord', { stored }),
  }
}

function refLabel(ref: CompositionSourceRef): string {
  return compositionSourceKey(ref)
}

function toRowSource(ref: CompositionSourceRef, fleet: FleetLookup): CompositionRowSource {
  const found = lookup(fleet, ref)
  return {
    key: compositionSourceKey(ref),
    label: found ? found.name : refLabel(ref),
    presence: presenceOf(found),
    deviceId: found ? found.id : null,
  }
}

function answeredDeviceId(view: CompositionView): number | null {
  return view.state.kind === 'answered' && view.state.state !== null
    ? view.state.state.deviceId
    : null
}

function toRow(view: CompositionView, fleet: FleetLookup): CompositionRow | null {
  const composition =
    view.block.source?.kind === 'composition' ? view.block.source.composition : null
  if (composition === null) return null
  const target = composition.target
  // The target is not one of its own sources: a customization may read its
  // own device (the doorbell counter reads the camera's `lastPressedAt`), and
  // listing it beside the real sources would read as a second device.
  const selfRef = target.kind === 'existing' ? target.device : composedDeviceRef(view.block.id)
  const selfKey = compositionSourceKey(selfRef)
  const sources = compositionSourceRefs(view)
    .filter((ref) => compositionSourceKey(ref) !== selfKey)
    .map((ref) => toRowSource(ref, fleet))
  const features = composition.features.map((feature) =>
    feature.enabled === false
      ? i18n.t('helpers.compositionRows.featureOff', { cap: feature.cap })
      : feature.cap,
  )
  const self = lookup(fleet, selfRef)
  const reported = answeredDeviceId(view)
  const state = describeCompositionState(view)
  if (target.kind === 'new') {
    return {
      blockId: view.block.id,
      kind: 'composed',
      name: view.block.name,
      namePresence: 'present',
      type: target.role === undefined ? target.type : `${target.type} · ${target.role}`,
      features,
      state,
      sources,
      reportedDeviceId: reported,
    }
  }
  const namePresence = presenceOf(self)
  return {
    blockId: view.block.id,
    kind: 'customization',
    name: self ? self.name : refLabel(target.device),
    namePresence,
    type: self ? self.type : null,
    features,
    state,
    sources,
    reportedDeviceId: reported,
  }
}

/** Broken rows first, then by name — a failure is read before a healthy row. */
function rank(row: CompositionRow): number {
  if (row.state.tone === 'error') return 0
  if (row.state.tone === 'pending') return 1
  if (row.state.tone === 'ok') return 2
  return 3
}

function byAttention(a: CompositionRow, b: CompositionRow): number {
  return rank(a) - rank(b) || a.name.localeCompare(b.name)
}

export function buildCompositionRows(
  views: readonly CompositionView[],
  fleet: FleetLookup,
): CompositionRowLists {
  const rows = views.flatMap((view) => {
    const row = toRow(view, fleet)
    return row === null ? [] : [row]
  })
  return {
    composed: rows.filter((row) => row.kind === 'composed').toSorted(byAttention),
    customizations: rows.filter((row) => row.kind === 'customization').toSorted(byAttention),
  }
}
