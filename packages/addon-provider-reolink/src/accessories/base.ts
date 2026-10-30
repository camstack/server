/**
 * Reolink accessory base layer — kind enum, parent-host contract,
 * shared `BaseDevice` glue every kind-specific subclass extends.
 *
 * Each accessory kind (Siren, Floodlight, PIR, Autotrack) lives in its
 * own file (`./siren.ts`, `./floodlight.ts`, …) with its own Zod
 * schema, settings UI, and cap-registration logic — they're
 * independent device classes that share only the parent reference and
 * the `channel` field.
 *
 * Why split per file:
 *   - Each kind owns a different subset of the lib's Baichuan
 *     surface (`setSiren`, `setWhiteLedState`, `setPirInfo`,
 *     `setAutotracking{,Settings}`) — keeping the dispatch in one
 *     monolithic switch obscures the per-kind contract.
 *   - Per-accessory settings UIs are different schemas; co-locating
 *     each schema with its consumer makes the kind self-contained
 *     (the file you read to understand "what does the siren expose"
 *     is `siren.ts`, full stop).
 *   - Adding a new kind (e.g. a future SpotlightAccessory) is one
 *     new file + one factory case, no edits to existing kinds.
 */

import { AccessoryKind, type AccessoryKindValue } from '@camstack/types'
import { z } from 'zod'

/**
 * Shared base fields every accessory subclass extends with its own
 * kind-specific knobs. The `channel` mirror lets multi-channel NVRs
 * route per-channel commands; single-camera devices stay on `0`.
 *
 * The `kind` field uses the **system-wide** `AccessoryKind` enum —
 * not a Reolink-specific narrow. Each per-kind subclass schema
 * locks down `kind: z.literal(AccessoryKind.X)` for its own value.
 */
export const reolinkAccessoryBaseSchema = z.object({
  channel: z.number().int().nonnegative().default(0),
  kind: z.string(),
})

/** Runtime guard: the four kinds Reolink models out of the full
 *  `AccessoryKind` set. The factory's `switch` is the canonical
 *  per-kind dispatch; this helper exists for the restore path,
 *  where saved rows can carry stale string values from older
 *  revisions and the addon needs a quick "do we still know how
 *  to spawn this?" check before attempting instantiation. */
export function isReolinkSupportedAccessoryKind(value: string): value is AccessoryKindValue {
  // `Autotrack` is intentionally NOT here — it lives on the parent
  // camera as the `ptz-autotrack` cap (PTZ extension), never as a
  // child device. A saved row carrying `kind: 'autotrack'` from a
  // pre-migration build would fall through this guard and the
  // restore path would skip it; the next `setSettings`/`setEnabled`
  // call on the parent's cap rebuilds the runtime state.
  return (
    value === AccessoryKind.Siren ||
    value === AccessoryKind.Floodlight ||
    value === AccessoryKind.PirSensor
  )
}

/**
 * Anything an accessory subclass needs from the parent camera. The
 * subclass receives this rather than a direct `ReolinkCamera`
 * reference so:
 *   - The accessory file doesn't import the camera class (avoids
 *     circular import the camera class doesn't need).
 *   - Tests can stub the host with a tiny fake instead of standing
 *     up a full camera.
 *   - The contract is explicit: subclasses use the parent's
 *     Baichuan socket via `ensureApi()` and read its display name
 *     for naming.
 */
/**
 * Aux-device reference exposed by each accessory to its parent.
 * The parent camera owns the periodic align scheduling (cadence,
 * sleep-gate, cooldown), the accessory owns the slice projection
 * + cooldown timestamp. Single 30s background poll thus replaces N
 * per-accessory timers AND can be sleep-gated centrally.
 */
export interface ReolinkAccessoryRef {
  readonly kind: string
  readonly id: number
  /** Read latest state from firmware and write into the slice. Best-
   *  effort: per-accessory failures are logged + swallowed by the
   *  caller (parent's alignAuxDevicesState). */
  refreshFromAlign(): Promise<void>
  /** True when a recent operator setState/setMotionTrigger call
   *  marked the cooldown — caller should skip align this round to
   *  avoid clobbering the just-applied state with a stale firmware
   *  read (camera takes 10s+ to reflect changes in some endpoints). */
  isInCooldown(): boolean
}

export interface ReolinkAccessoryHost {
  readonly name: string
  ensureApi(): Promise<unknown>
  /** True when the parent camera is battery-operated. Battery cams
   *  spend most of their time asleep; Baichuan polls on a sleeping
   *  camera return 400 (responseCode 400, empty body) AND drain the
   *  battery. The parent's `alignAuxDevicesState` skips polling
   *  entirely while sleeping and runs once on the sleep→awake
   *  transition.
   *  Optional for back-compat — host impls that don't expose battery
   *  info should return false (the safe default). */
  isBatteryCam?(): boolean
  /** True when the parent camera is currently asleep. Used by the
   *  accessory's `onProbe` to gate runtime refresh: at runtime we
   *  only fetch firmware state when the cam is already awake (per
   *  user policy — never wake a sleeping cam outside the explicit
   *  startup probe path). For wired cams this should always return
   *  false. Optional for back-compat. */
  isSleeping?(): boolean
  /** Accessories register themselves with the parent at construction
   *  so the parent's centralised `alignAuxDevicesState` can iterate
   *  them. Optional for back-compat — when absent the accessory
   *  silently skips registration (no align happens). */
  registerAccessoryChild?(ref: ReolinkAccessoryRef): void
}

/** Lib's Baichuan API — typed indirectly to avoid a hard dep on
 *  the lib in this file (kind-specific subclasses cast to the
 *  concrete shape they need). */
export type BaichuanApi = unknown

/** Re-export the system enum + values type so callers (factory)
 *  can build their dispatch tables off a single import. */
export { AccessoryKind, type AccessoryKindValue }
