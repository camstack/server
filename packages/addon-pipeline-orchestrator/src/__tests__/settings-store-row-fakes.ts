/**
 * The two doors the settings store reads rows through, over in-memory data: the addon's raw store
 * (node rows live in the same blob a spec's `state` fake writes) and the per-device store.
 */
import type { DeviceRowsPort } from '../orchestrator-row-maps.js'

export interface RowFakes {
  readonly readStore: () => Promise<Record<string, unknown>>
  readonly deviceSettings: () => DeviceRowsPort
  /** The per-device store as written, by device id. */
  readonly devices: Map<number, Record<string, unknown>>
}

export function rowFakes(readBlob: () => Record<string, unknown>): RowFakes {
  const devices = new Map<number, Record<string, unknown>>()
  const port: DeviceRowsPort = {
    readDeviceStore: async (id) => ({ ...devices.get(id) }),
    readDeviceStoreBatch: async (ids) =>
      new Map(ids.map((id) => [id, { ...devices.get(id) }] as const)),
    listDeviceStoreIds: async () => [...devices.keys()].toSorted((a, b) => a - b),
    writeDeviceStore: async (id, patch) => {
      const next: Record<string, unknown> = { ...devices.get(id) }
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete next[key]
        else next[key] = value
      }
      devices.set(id, next)
    },
  }
  return { readStore: async () => ({ ...readBlob() }), deviceSettings: () => port, devices }
}

/** A settings write against an in-memory blob: `undefined` removes the key (the store's contract). */
export function applyPatch(
  blob: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...blob }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  return next
}

/**
 * A spec that seeds the readable legacy map shape (`agentSettings`, `nodeBindings`,
 * `cameraSettings`) gets it as the migration leaves the store: node rows in the blob, the camera
 * entries in the per-device store.
 */
export function explodeLegacySeed(seed: Readonly<Record<string, unknown>>): {
  readonly blob: Record<string, unknown>
  readonly devices: ReadonlyMap<number, Record<string, unknown>>
} {
  const blob: Record<string, unknown> = { ...seed }
  const devices = new Map<number, Record<string, unknown>>()
  const asMap = (v: unknown): Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v) ? { ...v } : {}
  for (const field of ['agentSettings', 'nodeBindings']) {
    if (!(field in blob)) continue
    for (const [nodeId, entry] of Object.entries(asMap(blob[field])))
      blob[`${field}@${nodeId}`] = entry
    delete blob[field]
  }
  if ('cameraSettings' in blob) {
    for (const [id, entry] of Object.entries(asMap(blob['cameraSettings']))) {
      devices.set(Number(id), { cameraSettings: entry })
    }
    delete blob['cameraSettings']
  }
  return { blob, devices }
}
