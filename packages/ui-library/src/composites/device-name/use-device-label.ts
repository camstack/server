/**
 * `useDeviceLabel` is the string `DeviceName` renders — sort keys, aria
 * labels, confirm copy and search titles call it instead of painting
 * `device.name`.
 */
import { useUiText } from '../../contexts/ui-text'
import { isDeviceNameStock, nounSpecFor } from './device-name-nouns'
import type { DeviceNameIndex } from './device-fleet'
import { useDeviceNameIndex } from './device-fleet'
import {
  type DeviceNameFields,
  type DeviceNameForm,
  type DeviceNameNouns,
  formatDeviceName,
} from './format-device-name'

export interface DeviceNameScope {
  /** When set, including `null`, the fleet is not asked who the parent is. */
  readonly parent?: DeviceNameFields | null
  readonly siblings?: readonly DeviceNameFields[]
}

export function useDeviceNameNouns(): DeviceNameNouns {
  const t = useUiText()
  return {
    shortNoun(role, type) {
      const spec = nounSpecFor(role, type)
      return t(spec.key, spec.shortEn)
    },
    isStockPhrase(text, role, type) {
      return isDeviceNameStock(text, role, type)
    },
  }
}

function placeholderParent(id: number): DeviceNameFields {
  return {
    id,
    name: `#${String(id)}`,
    type: 'unknown',
    stableId: '',
    role: null,
    parentDeviceId: null,
  }
}

function parentFromIndex(
  device: DeviceNameFields,
  index: DeviceNameIndex,
): DeviceNameFields | null {
  const parentId = device.parentDeviceId
  if (parentId === null || parentId === undefined) return null
  return index.byId.get(parentId) ?? placeholderParent(parentId)
}

function siblingsFromIndex(
  device: DeviceNameFields,
  index: DeviceNameIndex,
): readonly DeviceNameFields[] {
  const parentId = device.parentDeviceId
  if (parentId === null || parentId === undefined) return []
  const ids = index.childIds.get(parentId) ?? []
  const siblings: DeviceNameFields[] = []
  for (const id of ids) {
    const row = index.byId.get(id)
    if (row !== undefined) siblings.push(row)
  }
  if (!siblings.some((sibling) => sibling.id === device.id)) siblings.push(device)
  return siblings
}

/**
 * Label for a device the caller already holds. While the fleet has not
 * answered and no parent was passed, this is the stored name — not `#id`.
 */
export function resolveDeviceLabel(
  device: DeviceNameFields,
  form: DeviceNameForm,
  index: DeviceNameIndex | null,
  nouns: DeviceNameNouns,
  scope?: DeviceNameScope,
): string {
  const known = index?.byId.get(device.id)
  const subject = known ?? device
  const parentId = subject.parentDeviceId
  const needsParent = parentId !== null && parentId !== undefined
  if (needsParent && index === null && scope?.parent === undefined) return subject.name
  const parent =
    scope?.parent !== undefined
      ? scope.parent
      : index === null
        ? null
        : parentFromIndex(subject, index)
  const siblings = scope?.siblings ?? (index === null ? [] : siblingsFromIndex(subject, index))
  return formatDeviceName(subject, form, { parent, siblings }, nouns)
}

export function useDeviceLabel(
  device: DeviceNameFields,
  form: DeviceNameForm,
  scope?: DeviceNameScope,
): string {
  const index = useDeviceNameIndex()
  const nouns = useDeviceNameNouns()
  return resolveDeviceLabel(device, form, index, nouns, scope)
}

/** `#id` until the fleet answers, and `#id` when the id is not in it. */
export function useDeviceLabelById(id: number, form: DeviceNameForm, pendingName?: string): string {
  const index = useDeviceNameIndex()
  const nouns = useDeviceNameNouns()
  if (index === null) return pendingName ?? `#${String(id)}`
  const device = index.byId.get(id)
  if (device === undefined) return `#${String(id)}`
  return resolveDeviceLabel(device, form, index, nouns)
}
