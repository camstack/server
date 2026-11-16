/**
 * Names for the log table's integration and device columns.
 *
 * The rows carry ids (`tags.addonId` / the `addon:<id>` scope, `tags.deviceId`).
 * The names come from two lists the table reads ONCE (the addons list and the
 * slim device list, both cached by the query client) — never one request per
 * row. An id the lists do not know yet shows as itself.
 */
import type { LogWireEntry } from './log-history-paging'

export type NameIndex = ReadonlyMap<string, string>

function fieldOf(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

/** `addons.list` → addonId → the addon's own name (else its package's display name). */
export function addonNameIndex(addons: readonly unknown[] | undefined): NameIndex {
  const out = new Map<string, string>()
  for (const addon of addons ?? []) {
    const manifest = fieldOf(addon, 'manifest')
    const id = fieldOf(manifest, 'id')
    if (typeof id !== 'string' || id.length === 0) continue
    const name = fieldOf(manifest, 'name')
    const packageName = fieldOf(manifest, 'packageDisplayName')
    out.set(
      id,
      typeof name === 'string' ? name : typeof packageName === 'string' ? packageName : id,
    )
  }
  return out
}

/** The slim device list → deviceId (as the tag spells it) → the name an operator gave it. */
export function deviceNameIndex(devices: readonly unknown[] | undefined): NameIndex {
  const out = new Map<string, string>()
  for (const device of devices ?? []) {
    const id = fieldOf(device, 'id')
    if (typeof id !== 'number') continue
    const label = fieldOf(fieldOf(device, 'display'), 'label')
    const name = fieldOf(device, 'name')
    const best =
      typeof label === 'string' && label.trim() !== ''
        ? label.trim()
        : typeof name === 'string' && name !== ''
          ? name
          : null
    if (best !== null) out.set(String(id), best)
  }
  return out
}

/** The addon a line came from: its tag, else the `addon:<id>` scope. */
export function entryAddonId(entry: LogWireEntry): string | null {
  const tagged = entry.tags?.addonId
  if (tagged !== undefined && tagged !== '') return tagged
  const scope = entry.scope
  if (scope?.startsWith('addon:') === true && scope.length > 'addon:'.length) {
    return scope.slice('addon:'.length)
  }
  return null
}

export function entryDeviceId(entry: LogWireEntry): string | null {
  const id = entry.tags?.deviceId
  return id !== undefined && String(id) !== '' ? String(id) : null
}

/** A name from the index, the id itself when the index does not know it (yet). */
export function nameOrId(index: NameIndex | null, id: string): string {
  return index?.get(id) ?? id
}
