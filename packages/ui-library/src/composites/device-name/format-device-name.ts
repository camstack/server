/**
 * One display name for a device.
 *
 * Canonical copy: `packages/ui-library/src/composites/device-name/format-device-name.ts`.
 * The viewer mirrors this file; `scripts/check-device-name-in-sync.ts` diffs the two.
 * Noun strings stay outside — this file only decides which noun to ask for.
 */
import { resolveContainerPrimaryChild } from '@camstack/types/client'

/** Middle dot used between a container and its noun, and before a room. */
export const DEVICE_NAME_JOIN: string = ' · '

export const DEVICE_NAME_FORMS: readonly ['compact', 'full', 'nested', 'with-location'] = [
  'compact',
  'full',
  'nested',
  'with-location',
]

export type DeviceNameForm = (typeof DEVICE_NAME_FORMS)[number]

/** The slice a label needs. A slim fleet row satisfies it. */
export interface DeviceNameFields {
  readonly id: number
  readonly name: string
  readonly type: string
  readonly stableId: string
  readonly role?: string | null
  readonly parentDeviceId?: number | null
  readonly location?: string | null
  readonly display?: { readonly label?: string | null } | null
  readonly userNamed?: boolean
  readonly primaryChildEntityId?: string | null
}

export interface DeviceNameContext {
  readonly parent: DeviceNameFields | null
  readonly siblings: readonly DeviceNameFields[]
}

/** Active-locale short noun, and the stock-word test (every locale). */
export type DeviceNameShortNoun = (role: string | null, type: string) => string

export type DeviceNameStockPhrase = (text: string, role: string | null, type: string) => boolean

export interface DeviceNameNouns {
  readonly shortNoun: DeviceNameShortNoun
  readonly isStockPhrase: DeviceNameStockPhrase
}

const PARENT_SEPARATORS: readonly string[] = [' — ', ' - ', ': ', ' ']

/**
 * Readings that are never what a container is. Matches the comment on
 * `CONTAINER_CHILD_ROLE_PRIORITY`: battery, temperature, humidity, illuminance,
 * signal, last-seen, plus numeric and enum. `update` is the same kind of row.
 */
const DIAGNOSTIC_ROLES: ReadonlySet<string> = new Set([
  'battery-sensor',
  'temperature-sensor',
  'humidity-sensor',
  'ambient-light-sensor',
  'connectivity-sensor',
  'datetime-sensor',
  'numeric-sensor',
  'enum-sensor',
])

/** Hyphen, underscore and whitespace fold together — the namesake comparison. */
export function foldDeviceName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[-_\s]+/g, ' ')
    .trim()
}

export function sameDeviceName(left: string, right: string): boolean {
  return foldDeviceName(left) === foldDeviceName(right)
}

/**
 * Drop a parent prefix. The separators `" — "`, `" - "` and `": "` are tried
 * before a plain space, case-insensitive, so a provider that capitalised the
 * parent differently still strips, and a dash or colon child does not keep a
 * dangling mark.
 */
export function stripDeviceParentPrefix(name: string, parentName: string): string {
  if (parentName.length === 0) return name
  const nameFold = name.toLowerCase()
  const parentFold = parentName.toLowerCase()
  for (const separator of PARENT_SEPARATORS) {
    const prefix = `${parentFold}${separator}`
    if (!nameFold.startsWith(prefix)) continue
    return name.slice(prefix.length).trim()
  }
  return name
}

function roleOf(device: DeviceNameFields): string | null {
  const role = device.role
  if (role === undefined || role === null || role.length === 0) return null
  return role
}

function isDiagnostic(device: DeviceNameFields): boolean {
  if (device.type === 'update') return true
  const role = roleOf(device)
  return role !== null && DIAGNOSTIC_ROLES.has(role)
}

function displayLabel(device: DeviceNameFields): string {
  const label = device.display?.label
  if (label === undefined || label === null) return ''
  return label.trim()
}

function nounOf(
  device: DeviceNameFields,
  parent: DeviceNameFields,
  nouns: DeviceNameNouns,
): string {
  const caption = displayLabel(device)
  if (caption.length > 0) return caption
  const stripped = stripDeviceParentPrefix(device.name, parent.name)
  const shown = stripped.length > 0 ? stripped : device.name
  if (device.userNamed === true) return shown
  const stock =
    stripped.length === 0 ||
    sameDeviceName(stripped, parent.name) ||
    nouns.isStockPhrase(shown, roleOf(device), device.type)
  if (stock) return nouns.shortNoun(roleOf(device), device.type)
  return shown
}

function foldsIntoParent(
  device: DeviceNameFields,
  parent: DeviceNameFields,
  noun: string,
): boolean {
  if (sameDeviceName(noun, parent.name)) return true
  if (displayLabel(device).length > 0 || device.userNamed === true) return false
  return sameDeviceName(stripDeviceParentPrefix(device.name, parent.name), parent.name)
}

function meaningfulChildCount(siblings: readonly DeviceNameFields[]): number {
  let count = 0
  for (const sibling of siblings) {
    if (!isDiagnostic(sibling)) count += 1
  }
  return count
}

function isContainerPrimary(
  device: DeviceNameFields,
  parent: DeviceNameFields,
  siblings: readonly DeviceNameFields[],
): boolean {
  const picked = resolveContainerPrimaryChild(
    siblings.map((sibling) => {
      const role = roleOf(sibling)
      return {
        id: sibling.id,
        stableId: sibling.stableId,
        type: sibling.type,
        name: sibling.name,
        ...(role === null ? {} : { role }),
      }
    }),
    parent.primaryChildEntityId,
    parent.name,
  )
  return picked !== null && picked.id === device.id
}

function childLine(
  device: DeviceNameFields,
  parent: DeviceNameFields,
  siblings: readonly DeviceNameFields[],
  nouns: DeviceNameNouns,
  form: 'compact' | 'full',
): string {
  const noun = nounOf(device, parent, nouns)
  if (foldsIntoParent(device, parent, noun)) return parent.name
  const onlyMeaningful =
    form === 'compact' &&
    parent.type === 'container' &&
    isContainerPrimary(device, parent, siblings) &&
    meaningfulChildCount(siblings) === 1
  if (onlyMeaningful) return parent.name
  return `${parent.name}${DEVICE_NAME_JOIN}${noun}`
}

function joinLocation(label: string, location: string | null | undefined): string {
  if (location === undefined || location === null) return label
  const room = location.trim()
  if (room.length === 0) return label
  const already = label.split(DEVICE_NAME_JOIN).some((segment) => sameDeviceName(segment, room))
  if (already) return label
  return `${label}${DEVICE_NAME_JOIN}${room}`
}

function hasParent(
  device: DeviceNameFields,
  parent: DeviceNameFields | null,
): parent is DeviceNameFields {
  if (parent === null) return false
  const parentId = device.parentDeviceId
  return parentId !== null && parentId !== undefined
}

/**
 * The label for `form`. A top-level device keeps its stored name. A child uses
 * the noun: `compact` may stand in for the container when this child is what
 * the container is, `full` always names both unless they fold together,
 * `nested` is the noun alone, `with-location` is `compact` plus the room.
 */
export function formatDeviceName(
  device: DeviceNameFields,
  form: DeviceNameForm,
  context: DeviceNameContext,
  nouns: DeviceNameNouns,
): string {
  if (!hasParent(device, context.parent)) {
    return form === 'with-location' ? joinLocation(device.name, device.location) : device.name
  }
  if (form === 'nested') return nounOf(device, context.parent, nouns)
  const line = childLine(
    device,
    context.parent,
    context.siblings,
    nouns,
    form === 'full' ? 'full' : 'compact',
  )
  return form === 'with-location' ? joinLocation(line, device.location) : line
}
