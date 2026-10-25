import type { HmDevice } from 'nodehomematic'
import type { DiscoveredChildDevice } from '@camstack/types'
import { inferHmDeviceType, mapHmDeviceChannels } from './homematic-mapping.js'
import { deriveHmEntityPreviews } from './homematic-entity-derive.js'
import { DeviceType } from '@camstack/types'

/**
 * Minimal structural subset of `HmDevice` required by this module. Using a
 * `Pick` keeps the function signature tight while remaining structurally
 * compatible with both live `HmDevice` instances and test fixtures that
 * supply the same fields — no cast needed at the call site.
 *
 * `type` carries the CCU device-type string (e.g. `'HmIP-BSM'`), which is
 * the closest model identifier available on the wire and is surfaced in
 * `metadata.model` for the adoption panel.
 *
 * `rooms` carries the CCU room assignment(s) (populated only when WebUI
 * credentials are configured on the broker); the first entry is surfaced in
 * `metadata.externalLocation` so the adoption flow can import it as a
 * CamStack location.
 *
 * The firmware fields (`firmware` / `availableFirmware` / `updatable` /
 * `firmwareUpdateState`) are included so the per-entity preview can derive a
 * firmware-update child via `mapFirmwareUpdate`.
 */
export type HmDiscoverable = Pick<
  HmDevice,
  | 'address'
  | 'name'
  | 'type'
  | 'channels'
  | 'rooms'
  | 'firmware'
  | 'availableFirmware'
  | 'updatable'
  | 'firmwareUpdateState'
>

export interface BuildHmCandidatesInput {
  readonly brokerId: string
  readonly devices: readonly HmDiscoverable[]
  /** hmAddress → adopted CamStack device id. */
  readonly adopted: ReadonlyMap<string, number>
}

/**
 * Map live Homematic devices to adoption candidates for the discovery panel.
 * Devices whose channels don't map to any supported `DeviceType` (i.e.
 * `Generic`) are omitted — remotes, key transceivers, maintenance channels,
 * and any device with no recognised channel type fall into this category.
 * Pure: no network I/O, no side effects.
 */
export function buildHmCandidates(input: BuildHmCandidatesInput): DiscoveredChildDevice[] {
  const out: DiscoveredChildDevice[] = []

  for (const device of input.devices) {
    const type = inferHmDeviceType(device)
    if (type === DeviceType.Generic) continue

    // Deduplicate caps across channels (e.g. a BSM switch + energy-meter
    // both contribute distinct caps; dedup prevents duplicates if the same
    // cap name is mapped by two channels on a multi-relay device).
    const caps = [...new Set(mapHmDeviceChannels(device).flatMap((m) => m.mapping.capabilities))]

    const adoptedId = input.adopted.get(device.address) ?? null

    // First CCU room → the source location the adoption flow can import.
    // Omitted entirely when the device carries no room (keeps `metadata` valid
    // — `externalLocation` is an optional field, never `undefined`-valued).
    const externalLocation = device.rooms?.[0]

    // Per-entity preview children for the modal accordion. The childNativeId is
    // `${address}#${entityKey}` — the entityKey reuses the SAME suffix scheme
    // the Container's getAccessoryChildren() uses, so a preview entity and the
    // eventual spawned accessory line up. Entity-level adoption is a separate
    // task; previews are NOT individually adoptable yet (alreadyAdopted=false).
    const children: DiscoveredChildDevice[] = deriveHmEntityPreviews(device).map((entity) => ({
      childNativeId: `${device.address}#${entity.key}`,
      name: entity.name,
      type: entity.type,
      status: 'online',
      metadata: {},
      alreadyAdopted: false,
      adoptedDeviceId: null,
      capabilities: entity.capabilities,
    }))

    out.push({
      childNativeId: device.address,
      name: device.name ?? device.address,
      type,
      status: 'online',
      metadata: {
        serialNumber: device.address,
        // `HmDevice.type` carries the CCU device-type string (e.g. 'HmIP-BSM'),
        // which is the closest available model identifier on the wire format.
        model: device.type,
        ...(externalLocation !== undefined ? { externalLocation } : {}),
      },
      alreadyAdopted: adoptedId !== null,
      adoptedDeviceId: adoptedId,
      capabilities: caps,
      children,
    })
  }

  return out
}
