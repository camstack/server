import { DeviceType, type DiscoveredChildDevice, type DiscoveryCandidate } from '@camstack/types'

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

/** A responder with the address it answered from — what an adoption proposal carries. */
export interface GreeResponder extends GreeDiscoverable {
  readonly ip: string
}

/** An adopted AC, by MAC, as the proposals recognise it. */
export interface GreeAdoptedAc {
  readonly deviceId: number
  readonly name: string
}

/**
 * Adoption proposals for the "Scan network" modal: one Container per responder,
 * carrying the IP it answered from (so an AC on a routed subnet is adopted by
 * that address) and recognising an AC already owned by its MAC. Pure.
 */
export function buildGreeProposals(
  responders: readonly GreeResponder[],
  adopted: ReadonlyMap<string, GreeAdoptedAc>,
): readonly DiscoveryCandidate[] {
  return responders.map((d): DiscoveryCandidate => {
    const displayName = d.name.length > 0 ? d.name : d.mac
    const owned = adopted.get(macKey(d.mac))
    return {
      stableId: `gree:${macKey(d.mac)}`,
      type: DeviceType.Container,
      suggestedName: displayName,
      prefilledConfig: {
        name: displayName,
        host: d.ip,
        ...(d.model !== undefined ? { model: d.model } : {}),
      },
      ...(owned !== undefined
        ? {
            alreadyOnboarded: true,
            onboardedDeviceId: owned.deviceId,
            onboardedName: owned.name,
          }
        : {}),
    }
  })
}
