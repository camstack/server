/**
 * Member picks for a group helper (D944 §5). The common selector asks with
 * `SourcePickRequest`: one device type, the catalog fields, direct matches
 * only. Incompatible values stay out — a group does not opt into them.
 */
import {
  historyFieldsFor,
  type DeviceType,
  type HelperMember,
  type SourcePickRequest,
} from '@camstack/types'

export interface MemberDevice {
  readonly id: number
  readonly name: string
  readonly type: string
  readonly location: string | null
  readonly parentDeviceId: number | null
  readonly addonId: string
  readonly stableId: string
  readonly caps: readonly string[]
}

export interface MemberField {
  readonly cap: string
  readonly fieldPath: string
  readonly kind: 'boolean' | 'number' | 'string' | 'enum'
}

export interface MemberSelection {
  readonly members: readonly HelperMember[]
  readonly refused: 'max' | null
  readonly needsField: readonly number[]
}

export function acceptCaps(request: SourcePickRequest): readonly string[] {
  return [...new Set(request.accept.map((field) => field.cap))]
}

export function partitionMemberDevices(
  devices: readonly MemberDevice[],
  request: SourcePickRequest,
): {
  readonly compatible: readonly MemberDevice[]
  readonly incompatible: readonly MemberDevice[]
} {
  const caps = new Set(acceptCaps(request))
  const hidden = new Set(request.exclude.map((ref) => `${ref.addonId}/${ref.stableId}`))
  const compatible: MemberDevice[] = []
  const incompatible: MemberDevice[] = []
  for (const device of devices) {
    if (hidden.has(`${device.addonId}/${device.stableId}`)) continue
    if (typeAllowed(device.type, request.deviceTypes) && device.caps.some((cap) => caps.has(cap))) {
      compatible.push(device)
    } else {
      incompatible.push(device)
    }
  }
  return { compatible, incompatible }
}

/** Fields that match the request exactly. A historised ask drops a field with no history declaration. */
export function directAcceptFields(
  fields: readonly MemberField[],
  request: SourcePickRequest,
): readonly MemberField[] {
  return fields.filter((field) => acceptedField(request, field) && recorded(request, field))
}

/** Accepted fields the historised ask cannot use, so the selector can say why. */
export function unhistorisedFields(
  fields: readonly MemberField[],
  request: SourcePickRequest,
): readonly MemberField[] {
  if (!request.history.required) return []
  return fields.filter((field) => acceptedField(request, field) && !hasHistory(field))
}

export function selectedIdsForMembers(
  members: readonly HelperMember[],
  devices: readonly MemberDevice[],
): readonly number[] {
  return members.flatMap((member) => {
    const device = devices.find(
      (row) => row.addonId === member.source.addonId && row.stableId === member.source.stableId,
    )
    return device === undefined ? [] : [device.id]
  })
}

/**
 * Turn a multi-select into members. One accept field is filled in. Several
 * (occupancy) wait for the field the operator picks. Over `max` keeps the
 * previous members and names the refusal.
 */
export function applyMemberSelection(input: {
  readonly request: SourcePickRequest
  readonly devices: readonly MemberDevice[]
  readonly selectedIds: readonly number[]
  readonly previous: readonly HelperMember[]
  readonly choiceDeviceId: number | null
  readonly choice: { readonly cap: string; readonly fieldPath: string } | null
}): MemberSelection {
  if (input.selectedIds.length > input.request.max) {
    return { members: input.previous.map(copyMember), refused: 'max', needsField: [] }
  }
  const needsField: number[] = []
  const members = input.selectedIds.flatMap((id) => {
    const device = input.devices.find((row) => row.id === id)
    if (device === undefined) return []
    const field = fieldForDevice(device, input)
    if (field === null) {
      needsField.push(id)
      return []
    }
    return [memberOf(device, field.cap, field.fieldPath)]
  })
  return { members, refused: null, needsField }
}

function fieldForDevice(
  device: MemberDevice,
  input: {
    readonly request: SourcePickRequest
    readonly previous: readonly HelperMember[]
    readonly choiceDeviceId: number | null
    readonly choice: { readonly cap: string; readonly fieldPath: string } | null
  },
): { readonly cap: string; readonly fieldPath: string } | null {
  if (
    input.choiceDeviceId === device.id &&
    input.choice !== null &&
    accepted(input.request, input.choice)
  ) {
    return input.choice
  }
  const previous = input.previous.find(
    (member) =>
      member.source.addonId === device.addonId && member.source.stableId === device.stableId,
  )
  if (previous !== undefined && accepted(input.request, previous)) return previous
  const candidates =
    input.request.fieldChoice === 'first-match'
      ? input.request.accept.filter((entry) => device.caps.includes(entry.cap))
      : input.request.accept
  const only =
    input.request.fieldChoice === 'first-match' || candidates.length === 1
      ? candidates[0]
      : undefined
  if (only === undefined) return null
  return { cap: only.cap, fieldPath: only.fieldPath }
}

function acceptedField(request: SourcePickRequest, field: MemberField): boolean {
  return request.accept.some(
    (accept) =>
      accept.cap === field.cap &&
      accept.fieldPath === field.fieldPath &&
      accept.valueKind === field.kind,
  )
}

function recorded(request: SourcePickRequest, field: MemberField): boolean {
  return !request.history.required || hasHistory(field)
}

function hasHistory(field: MemberField): boolean {
  return historyFieldsFor(field.cap)[field.fieldPath] !== undefined
}

function accepted(
  request: SourcePickRequest,
  field: { readonly cap: string; readonly fieldPath: string },
): boolean {
  return request.accept.some(
    (accept) => accept.cap === field.cap && accept.fieldPath === field.fieldPath,
  )
}

function typeAllowed(deviceType: string, allowed: readonly DeviceType[]): boolean {
  if (allowed.length === 0) return true
  return allowed.some((type) => type === deviceType)
}

function memberOf(device: MemberDevice, cap: string, fieldPath: string): HelperMember {
  return {
    source: { addonId: device.addonId, stableId: device.stableId },
    cap,
    fieldPath,
  }
}

function copyMember(member: HelperMember): HelperMember {
  return {
    source: { addonId: member.source.addonId, stableId: member.source.stableId },
    cap: member.cap,
    fieldPath: member.fieldPath,
  }
}
