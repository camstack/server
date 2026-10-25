import type { DiscoveredChildDevice } from '@camstack/types'
import { capsForKind, classifyDreoModel, deviceTypeForKind } from './dreo-domain-mapping.js'

/**
 * Minimal structural subset of a Dreo discovery info row the discovery code
 * needs. Using a `Pick`-like interface keeps the signature tight while staying
 * structurally compatible with the library's `DreoDeviceInfo` and test fixtures
 * — no cast at the call site.
 */
export interface DreoDiscoverable {
  readonly deviceId: string
  readonly model: string
  readonly name: string
}

export interface BuildDreoCandidatesInput {
  readonly devices: readonly DreoDiscoverable[]
  /** dreoDeviceId → adopted CamStack device id. */
  readonly adopted: ReadonlyMap<string, number>
}

/**
 * Map live Dreo discovery rows to adoption candidates. Devices whose model
 * classifies as `unsupported` are omitted. Pure: no network I/O, no side
 * effects. Mirrors `buildDreameCandidates`.
 */
export function buildDreoCandidates(input: BuildDreoCandidatesInput): DiscoveredChildDevice[] {
  const out: DiscoveredChildDevice[] = []
  for (const device of input.devices) {
    const kind = classifyDreoModel(device.model)
    if (kind === 'unsupported') continue
    const adoptedId = input.adopted.get(device.deviceId) ?? null
    out.push({
      childNativeId: device.deviceId,
      name: device.name.length > 0 ? device.name : device.deviceId,
      type: deviceTypeForKind(kind),
      status: 'online',
      metadata: {
        serialNumber: device.deviceId,
        model: device.model,
      },
      alreadyAdopted: adoptedId !== null,
      adoptedDeviceId: adoptedId,
      capabilities: [...capsForKind(kind)],
    })
  }
  return out
}
