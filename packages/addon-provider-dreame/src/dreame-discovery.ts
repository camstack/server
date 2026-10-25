import type { DiscoveredChildDevice } from '@camstack/types'
import { classifyDreameModel, controlCapForKind, deviceTypeForKind } from './dreame-mapping.js'

/**
 * Minimal structural subset of a Dreame device handle the discovery code needs.
 * Using a `Pick`-like interface keeps the function signature tight while staying
 * structurally compatible with the library's `BaseDevice` handle and test
 * fixtures — no cast at the call site.
 */
export interface DreameDiscoverable {
  readonly deviceId: string
  readonly model: string
  readonly name: string
}

export interface BuildDreameCandidatesInput {
  readonly devices: readonly DreameDiscoverable[]
  /** dreameDeviceId → adopted CamStack device id. */
  readonly adopted: ReadonlyMap<string, number>
}

/**
 * Map live Dreame device handles to adoption candidates. Devices whose model is
 * neither a vacuum nor a mower are omitted. Pure: no network I/O, no side
 * effects. Mirrors `buildHmCandidates`.
 */
export function buildDreameCandidates(input: BuildDreameCandidatesInput): DiscoveredChildDevice[] {
  const out: DiscoveredChildDevice[] = []
  for (const device of input.devices) {
    const kind = classifyDreameModel(device.model)
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
      capabilities: [controlCapForKind(kind)],
    })
  }
  return out
}
