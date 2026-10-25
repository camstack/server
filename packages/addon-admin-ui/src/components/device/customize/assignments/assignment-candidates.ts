/**
 * Who the assignment picker may offer (spec U13). Built from ONE `listAll`
 * read and the per-cap registry index — never a `getBindings` per candidate
 * (measured up to 5.24 s, D648). The search is the D636 picker's own
 * (`pickerSearchText` / `pickerQueryTokens`), so a query matches the same way
 * in every picker.
 */
import {
  type CompositionSourceRef,
  compositionSourceKey,
  DeviceType,
  SOURCE_CAP_ACTIVE_FIELD,
  SOURCE_CAPS,
} from '@camstack/types'
import { pickerQueryTokens, pickerSearchText } from '../../../../pages/system/device-picker-model'
import type { Known, QueryLike } from '../known'
import i18n from '../../../../i18n/index'
import type { LiveValueTarget } from './live-value'

export interface AssignmentCandidate {
  readonly deviceId: number
  readonly ref: CompositionSourceRef
  readonly name: string
  /** "Home Assistant · Porch"; null when neither is known. */
  readonly detail: string | null
  /** The third column: the cap the value is read from, or a type label. */
  readonly meta: string | null
  /** The compatible caps it carries (filter chips test these). */
  readonly caps: readonly string[]
  readonly value: LiveValueTarget | null
}

export interface AssignmentFilter {
  readonly id: string
  readonly labelKey: string
  readonly caps: readonly string[]
}

/** The motion picker's chips (Picker artboard): motion & presence (HA maps occupancy/presence to `motion`), contacts, all. */
export const MOTION_SENSOR_FILTERS: readonly AssignmentFilter[] = [
  { id: 'motion', labelKey: 'customize.assign.filters.motion', caps: ['motion'] },
  { id: 'contact', labelKey: 'customize.assign.filters.contact', caps: ['contact'] },
  { id: 'all', labelKey: 'customize.assign.filters.all', caps: SOURCE_CAPS },
]

/** Rows the picker draws before "Show N more" (the D636 page size). */
export const ASSIGNMENT_PAGE_SIZE = 60

export interface CandidateDevice {
  readonly id: number
  readonly name: string
  readonly addonId: string
  readonly stableId: string
  readonly type: string
  readonly location: string | null
  readonly isCamera: boolean
  /** The integration's display name; null while the integrations list has not answered. */
  readonly integration: string | null
  /** The device-tree parent (a container's child names it). */
  readonly parentDeviceId?: number | null
  /** A container's stored primary-child pick (the child's `stableId`). */
  readonly primaryChildEntityId?: string | null
  /** `DeviceRole`, ranked above type when a container's primary is resolved. */
  readonly role?: string | null
}

export interface SourceCandidatesInput {
  readonly devices: readonly CandidateDevice[]
  readonly capIndex: ReadonlyMap<number, readonly string[]>
  readonly hostId: number
  readonly excludeCameras: boolean
  /** `compositionSourceKey` of every ref already assigned. */
  readonly assigned: ReadonlySet<string>
  readonly preferredCap: string | null
}

export function primarySourceCap(caps: readonly string[], preferred: string | null): string | null {
  if (preferred !== null && caps.includes(preferred)) return preferred
  return SOURCE_CAPS.find((cap) => caps.includes(cap)) ?? null
}

export function candidateDetail(
  integration: string | null,
  location: string | null,
): string | null {
  const parts = [integration, location].filter((p): p is string => p !== null && p !== '')
  return parts.length === 0 ? null : parts.join(' · ')
}

function offered(device: CandidateDevice, input: SourceCandidatesInput): boolean {
  if (device.id === input.hostId || device.type === DeviceType.Container) return false
  if (input.excludeCameras && device.isCamera) return false
  const key = compositionSourceKey({ addonId: device.addonId, stableId: device.stableId })
  return !input.assigned.has(key)
}

export function sourceCandidates(input: SourceCandidatesInput): readonly AssignmentCandidate[] {
  return input.devices
    .flatMap((device): readonly AssignmentCandidate[] => {
      if (!offered(device, input)) return []
      const caps = input.capIndex.get(device.id) ?? []
      const cap = primarySourceCap(caps, input.preferredCap)
      if (cap === null) return []
      const field = SOURCE_CAP_ACTIVE_FIELD[cap]
      return [
        {
          deviceId: device.id,
          ref: { addonId: device.addonId, stableId: device.stableId },
          name: device.name,
          detail: candidateDetail(device.integration, device.location),
          meta: cap,
          caps,
          value: field === undefined ? null : { deviceId: device.id, cap, path: field },
        },
      ]
    })
    .toSorted((a, b) => a.name.localeCompare(b.name))
}

export function filterCandidates(
  candidates: readonly AssignmentCandidate[],
  query: string,
  filter: AssignmentFilter | null,
): readonly AssignmentCandidate[] {
  const tokens = pickerQueryTokens(query)
  return candidates.filter((c) => {
    if (filter !== null && !c.caps.some((cap) => filter.caps.includes(cap))) return false
    if (tokens.length === 0) return true
    const hay = pickerSearchText({
      id: c.deviceId,
      name: c.name,
      ...(c.detail === null ? {} : { detail: c.detail }),
      ...(c.meta === null ? {} : { type: c.meta }),
    })
    return tokens.every((token) => hay.includes(token))
  })
}

export interface CapIndexAnswer {
  readonly cap: string
  readonly query: QueryLike<readonly number[]>
}

/** cap → ids answers, inverted into id → caps; pending until ALL answered, unknown on the first failure. */
export function capIndexOf(
  answers: readonly CapIndexAnswer[],
): Known<ReadonlyMap<number, readonly string[]>> {
  const failed = answers.find((a) => a.query.status === 'error')
  if (failed !== undefined) {
    return {
      kind: 'unknown',
      reason: failed.query.error?.message ?? i18n.t('helpers.customize.requestFailed'),
    }
  }
  if (answers.some((a) => a.query.status !== 'success' || a.query.data === undefined)) {
    return { kind: 'pending' }
  }
  const index = new Map<number, string[]>()
  for (const answer of answers) {
    for (const id of answer.query.data ?? []) index.set(id, [...(index.get(id) ?? []), answer.cap])
  }
  return { kind: 'known', value: index }
}
