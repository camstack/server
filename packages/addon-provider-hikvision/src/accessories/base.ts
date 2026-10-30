/**
 * Hikvision accessory base layer — host contract + shared schema bits
 * every per-kind subclass extends.
 *
 * Each accessory kind (Light, Siren) lives in its own file with its
 * own Zod schema, settings UI, and cap registration — they're
 * independent device classes that share only the parent reference and
 * the `cameraNumber` field (Hikvision encodes channels as
 * `{cameraNumber}{streamSlot}` — `1` for single-camera devices,
 * `2`/`3`/... for multi-channel NVRs).
 *
 * Mirrors Reolink's per-file accessory pattern:
 *   - Co-located schema + UI + class makes the kind self-contained.
 *   - The parent doesn't know which caps each kind exposes — it only
 *     declares "spawn a Siren child" via `getAccessoryChildren()`.
 *   - Adding a new kind (e.g. RelayOutput) is one new file + one
 *     factory case, no edits to existing kinds.
 */

import { AccessoryKind, type AccessoryKindValue } from '@camstack/types'
import { z } from 'zod'
import type { HikvisionIsapiClient } from '../hikvision-isapi-client.js'

/**
 * Shared base fields every accessory subclass extends. The
 * `cameraNumber` mirror is the parent-camera ISAPI channel offset
 * (`1` for single-camera devices, `2+` on multi-channel NVRs); siren
 * accessories ignore it (alarm IO is device-wide on Hikvision) but
 * carry it for shape parity.
 *
 * The `kind` field uses the **system-wide** `AccessoryKind` enum —
 * not a Hikvision-specific narrow. Each per-kind subclass schema
 * locks down `kind: z.literal(AccessoryKind.X)` for its own value.
 */
export const hikvisionAccessoryBaseSchema = z.object({
  cameraNumber: z.number().int().positive().default(1),
  kind: z.string(),
})

/**
 * Anything an accessory subclass needs from the parent camera. The
 * subclass receives this rather than a direct `HikvisionCamera`
 * reference so:
 *   - The accessory file doesn't import the camera class (avoids a
 *     circular import the camera class doesn't need).
 *   - Tests can stub the host with a tiny fake instead of standing up
 *     a full camera + ISAPI client.
 *   - The contract is explicit: subclasses call `ensureClient()` for
 *     a typed ISAPI client and read the parent's name for fallback
 *     log tags.
 */
export interface HikvisionAccessoryHost {
  readonly name: string
  ensureClient(): HikvisionIsapiClient
}

/** Re-export the system enum + values type so callers (factory) can
 *  build their dispatch tables off a single import. */
export { AccessoryKind, type AccessoryKindValue }

/**
 * Runtime guard: the two kinds Hikvision currently models out of the
 * full `AccessoryKind` set (Light → supplemental white light,
 * Siren → alarm output). The factory's `switch` is the canonical
 * per-kind dispatch; this helper exists for the restore path, where
 * saved rows can carry stale string values from older revisions and
 * the addon needs a quick "do we still know how to spawn this?"
 * check before attempting instantiation.
 */
export function isHikvisionSupportedAccessoryKind(value: string): value is AccessoryKindValue {
  return value === AccessoryKind.Floodlight || value === AccessoryKind.Siren
}
