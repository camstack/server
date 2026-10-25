import { DeviceType, type DiscoveredChildDevice } from '@camstack/types'

/**
 * Minimal structural subset of a Gree discovery row the discovery code needs.
 * Using a `Pick`-like interface keeps the signature tight while staying
 * structurally compatible with the library's `DiscoveredDevice` and test
 * fixtures — no cast at the call site.
 */
export interface GreeDiscoverable {
  readonly mac: string
  readonly name: string
  readonly model?: string
}

export interface BuildGreeCandidatesInput {
  readonly devices: readonly GreeDiscoverable[]
  /** mac (lowercased) → adopted CamStack device id. */
  readonly adopted: ReadonlyMap<string, number>
}

/** Lowercase a MAC for stable keying (Gree echoes mixed-case MACs). */
function macKey(mac: string): string {
  return mac.toLowerCase()
}

/**
 * Map Gree discovery rows to adoption candidates — one Thermostat-type candidate
 * per AC. Every discovered AC is a valid candidate (there is no "unsupported"
 * sub-kind — they are all air conditioners). Pure: no network I/O, no side
 * effects. Mirrors `buildDreoCandidates`.
 */
export function buildGreeCandidates(input: BuildGreeCandidatesInput): DiscoveredChildDevice[] {
  const out: DiscoveredChildDevice[] = []
  for (const device of input.devices) {
    const adoptedId = input.adopted.get(macKey(device.mac)) ?? null
    out.push({
      childNativeId: macKey(device.mac),
      name: device.name.length > 0 ? device.name : device.mac,
      type: DeviceType.Climate,
      status: 'online',
      metadata: {
        serialNumber: device.mac,
        ...(device.model !== undefined ? { model: device.model } : {}),
      },
      alreadyAdopted: adoptedId !== null,
      adoptedDeviceId: adoptedId,
      capabilities: ['climate-control', 'fan-control'],
    })
  }
  return out
}
