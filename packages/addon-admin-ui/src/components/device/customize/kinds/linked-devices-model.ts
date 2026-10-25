/**
 * The linked-devices table's model (spec U7): the D648 slot as its owner
 * reads it, and the writes it accepts. The owner validates (container, self,
 * unknown id — D648 rule 4; tracked outside the linked set — D655); this file
 * only builds values the owner would accept from what it READ (D49).
 */
import type {
  ExtensionCandidate,
  ExtensionSlotRow,
  ExtensionSlotState,
  ExtensionSlotValue,
  ExtensionSourceHealth,
} from '@camstack/types'
import {
  type AssignmentCandidate,
  type CandidateDevice,
  candidateDetail,
} from '../assignments/assignment-candidates'
import type { QueryLike } from '../known'
import i18n from '../../../../i18n/index'

export type LinkedSlotValue = Extract<ExtensionSlotValue, { readonly slot: 'linked-devices' }>

export type LinkedSlotRead =
  | { readonly kind: 'pending' }
  | { readonly kind: 'unknown'; readonly reason: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly slot: ExtensionSlotState; readonly value: LinkedSlotValue }

function isLinkedValue(value: ExtensionSlotValue): value is LinkedSlotValue {
  return value.slot === 'linked-devices'
}

export function linkedSlotOf(query: QueryLike<readonly ExtensionSlotRow[]>): LinkedSlotRead {
  if (query.status === 'error')
    return {
      kind: 'unknown',
      reason: query.error?.message ?? i18n.t('helpers.customize.requestFailed'),
    }
  if (query.status === 'pending' || query.data === undefined) return { kind: 'pending' }
  for (const row of query.data) {
    if (row.state === 'ok' && row.slot === 'linked-devices' && isLinkedValue(row.value)) {
      return { kind: 'present', slot: row, value: row.value }
    }
  }
  const unreachable = query.data.find((row) => row.state === 'unreachable')
  return unreachable !== undefined && unreachable.state === 'unreachable'
    ? { kind: 'unknown', reason: unreachable.reason }
    : { kind: 'absent' }
}

export interface LinkedRow {
  readonly deviceId: number
  readonly name: string | null
  readonly health: ExtensionSourceHealth
  readonly implied: boolean
  readonly tracked: boolean
}

export function linkedRows(slot: ExtensionSlotState, value: LinkedSlotValue): readonly LinkedRow[] {
  const tracked = value.trackedDeviceIds ?? []
  const row =
    (implied: boolean) =>
    (s: ExtensionSlotState['sources'][number]): LinkedRow => ({
      deviceId: s.deviceId,
      name: s.name,
      health: s.health,
      implied,
      tracked: tracked.includes(s.deviceId),
    })
  return [...slot.sources.map(row(false)), ...(slot.impliedSources ?? []).map(row(true))]
}

/**
 * Stored opt-ins whose device is no longer linked (a container pick removed
 * leaves its children's opt-ins behind). Every write sends them back and the
 * owner keeps them, so the table must SHOW them and let them be untracked —
 * never carry state nobody can see (D655, task 8 review M2).
 */
export function orphanTrackedIds(
  slot: ExtensionSlotState,
  value: LinkedSlotValue,
): readonly number[] {
  const shown = new Set([...slot.sources, ...(slot.impliedSources ?? [])].map((s) => s.deviceId))
  return (value.trackedDeviceIds ?? []).filter((id) => !shown.has(id))
}

export function withLinked(value: LinkedSlotValue, ids: readonly number[]): LinkedSlotValue {
  return {
    ...value,
    deviceIds: [...value.deviceIds, ...ids.filter((id) => !value.deviceIds.includes(id))],
  }
}

export function withoutLinked(value: LinkedSlotValue, id: number): LinkedSlotValue {
  return {
    ...value,
    deviceIds: value.deviceIds.filter((x) => x !== id),
    ...(value.trackedDeviceIds === undefined
      ? {}
      : { trackedDeviceIds: value.trackedDeviceIds.filter((x) => x !== id) }),
  }
}

export function withTracked(value: LinkedSlotValue, id: number, on: boolean): LinkedSlotValue {
  const current = value.trackedDeviceIds ?? []
  const next = on ? [...current.filter((x) => x !== id), id] : current.filter((x) => x !== id)
  return { ...value, trackedDeviceIds: next }
}

export function linkedCandidates(
  candidates: readonly ExtensionCandidate[],
  devices: ReadonlyMap<number, CandidateDevice>,
  linked: ReadonlySet<number>,
): readonly AssignmentCandidate[] {
  return candidates.flatMap((c) => {
    const device = devices.get(c.deviceId)
    if (linked.has(c.deviceId) || device === undefined) return []
    return [
      {
        deviceId: c.deviceId,
        ref: { addonId: device.addonId, stableId: device.stableId },
        name: c.parentName === null ? c.name : `${c.parentName} · ${c.name}`,
        detail: candidateDetail(device.integration, c.location),
        meta: c.type,
        caps: [],
        value: null,
      },
    ]
  })
}
