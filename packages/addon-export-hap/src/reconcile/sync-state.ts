/**
 * Pure (de)serialization between the persisted JSON sync state
 * (`ExportHapConfig.exportSyncState`) and the runtime
 * `Map<number, ExportTargetEntry>` the reconciler works on. The store persists
 * a JSON blob (string keys); the reconciler keys on numeric device ids. Arrays
 * are copied so neither side aliases the other's storage.
 */
import type { ExportTargetEntry } from '@camstack/types/node'
import type { ExportTargetEntryJson } from '../hap-export.addon.js'

export type ExportSyncStateJson = Readonly<Record<string, ExportTargetEntryJson>>

export function syncStateFromJson(json: ExportSyncStateJson): Map<number, ExportTargetEntry> {
  const map = new Map<number, ExportTargetEntry>()
  for (const [key, entry] of Object.entries(json)) {
    // Use Number(key) instead of Number.parseInt(key, 10): parseInt('5abc', 10)
    // returns 5 (accepts partial-numeric strings), whereas Number('5abc') is NaN
    // (correctly rejected). Only accept keys that are whole integers.
    const deviceId = Number(key)
    if (!Number.isInteger(deviceId)) continue
    map.set(deviceId, { fingerprint: entry.fingerprint, externalIds: [...entry.externalIds] })
  }
  return map
}

export function syncStateToJson(map: ReadonlyMap<number, ExportTargetEntry>): ExportSyncStateJson {
  const out: Record<string, ExportTargetEntryJson> = {}
  for (const [deviceId, entry] of map) {
    out[String(deviceId)] = { fingerprint: entry.fingerprint, externalIds: [...entry.externalIds] }
  }
  return out
}
