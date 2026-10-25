import type { DiscoveredChildDevice } from '@camstack/types'
import { classifyTuyaCategory, deviceTypeForKind } from './tuya-dp-mapping.js'
import type { TuyaCatalogEntry } from './tuya-gateway.js'

/** The cap name a candidate advertises for each kind (informational, for the panel). */
function capForKind(kind: 'switch' | 'kettle'): string {
  return kind === 'kettle' ? 'water-heater' : 'switch'
}

export interface BuildTuyaCandidatesInput {
  readonly entries: readonly TuyaCatalogEntry[]
  /** tuyaDeviceId → adopted CamStack device id. */
  readonly adopted: ReadonlyMap<string, number>
}

/**
 * Map an account's cloud catalog entries to adoption candidates. Every entry is
 * adoptable (unknown categories fall back to a raw on/off switch); the candidate
 * `type` is the CamStack DeviceType the entry will materialise as. Pure: no
 * network I/O, no side-effects. Mirrors `buildDreameCandidates`.
 */
export function buildTuyaCandidates(input: BuildTuyaCandidatesInput): DiscoveredChildDevice[] {
  const out: DiscoveredChildDevice[] = []
  for (const entry of input.entries) {
    const kind = classifyTuyaCategory(entry.category)
    const adoptedId = input.adopted.get(entry.deviceId) ?? null
    out.push({
      childNativeId: entry.deviceId,
      name: entry.name.length > 0 ? entry.name : entry.deviceId,
      type: deviceTypeForKind(kind),
      status: entry.online === false ? 'offline' : 'online',
      metadata: {
        serialNumber: entry.deviceId,
        ...(entry.category !== undefined ? { model: entry.category } : {}),
      },
      alreadyAdopted: adoptedId !== null,
      adoptedDeviceId: adoptedId,
      capabilities: [capForKind(kind)],
    })
  }
  return out
}
