/**
 * Pure mapping: cloud camera list → `device-adoption` candidates.
 *
 * Mirrors `buildDreoCandidates` — no network I/O, no side effects, so it is
 * exhaustively unit-testable without the lib or a live account. A camera is a
 * candidate only when it carries the local P2P parameters the DTLS client
 * needs (`isAdoptableCamera`).
 */

import { DeviceType } from '@camstack/types'
import type { DiscoveredChildDevice } from '@camstack/types'
import type { WyzeCamera } from '@apocaliss92/wyze-bridge-js'
import { isAdoptableCamera } from './mapping.js'

export interface BuildWyzeCandidatesInput {
  readonly cameras: readonly WyzeCamera[]
  /** MAC (uppercased) → adopted CamStack device id. */
  readonly adopted: ReadonlyMap<string, number>
}

/**
 * Map live cloud cameras to adoption candidates. The `childNativeId` is the
 * camera MAC — globally unique + durable, the same key used for the device
 * stableId — so re-discovery of an already-adopted camera is de-duped.
 */
export function buildWyzeCandidates(input: BuildWyzeCandidatesInput): DiscoveredChildDevice[] {
  const out: DiscoveredChildDevice[] = []
  for (const cam of input.cameras) {
    if (!isAdoptableCamera(cam)) continue
    const adoptedId = input.adopted.get(cam.mac.toUpperCase()) ?? null
    out.push({
      childNativeId: cam.mac,
      name: cam.nickname || cam.productModel || cam.mac,
      type: DeviceType.Camera,
      status: cam.isOnline === false ? 'offline' : 'online',
      metadata: {
        serialNumber: cam.mac,
        model: cam.productModel,
        manufacturer: 'Wyze',
      },
      alreadyAdopted: adoptedId !== null,
      adoptedDeviceId: adoptedId,
    })
  }
  return out
}
