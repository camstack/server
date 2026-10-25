/**
 * The per-device state half of a migration (`deviceManager.migrateDevice`).
 *
 * ## The rule
 *
 * **Role-scoped state follows the NUMBER. Hardware-scoped state follows the
 * DEVICE.** `swapIds` moves the device ROWS — `addonId` and `stableId` follow
 * the hardware — but the per-device CONFIG blob and the runtime-state blob are
 * keyed by the number in a separate store, and until 2026-09-01 they simply
 * stayed put. Measured on the live hub after replacing a Hikvision (id 618)
 * with a Reolink: device 108 — Reolink hardware — was dialled at
 * `192.168.10.245:80` with `deviceCache.model="DS-2DE2A404IW-DE3/W"`, the
 * Hikvision's address, credentials and cached model, and never came online.
 * Device 4362 wore the Reolink's config on Hikvision hardware. The two devices
 * were wearing each other's identity.
 *
 * The proof the config belongs to the hardware, not the number: writing the
 * Hikvision blob onto the Reolink was REJECTED by the Reolink driver's own
 * zod schema (`motionSensitivity: 60` vs max 50). A config that fails the
 * other provider's schema is a config for different hardware.
 *
 * ## What swaps, what stays
 *
 *  - The DRIVER config keys (host, port, credentials, `deviceCache`, every
 *    schema field) SWAP — they describe the box.
 *  - The device-manager-owned linked-devices keys (mode, ids, tracked-event
 *    opt-in — {@link ROLE_SCOPED_CONFIG_KEYS}) STAY with the number — a sensor
 *    is linked to "the driveway camera", not to a serial number.
 *  - `_profileMap` is DROPPED from both. It is the legacy spelling of the
 *    stream-profile assignment (the live authority is the stream broker's own
 *    map — see `StreamsTab.tsx`, which stopped writing it), and either copy
 *    names stream ids of the wrong hardware after a swap.
 *  - The runtime-state blobs (`__device-state:<id>` — battery snapshot, sleep
 *    flag, feature probe) SWAP wholesale: every slice mirrors the box — never
 *    while either carries `$owned` (D663): the migration is refused first
 *    ({@link assertNoFieldClaims}). A claim names the NUMBER, the block that
 *    owns it names a STABLE ID, and the swap moves the stable id to the other
 *    number; whatever it did with `$owned`, one of the two keys would end up
 *    on the wrong device.
 *
 * ## Crash points are loud, same as `swapIds`
 *
 * There is no transaction: each blob is cleared and rewritten. A crash between
 * clear and write leaves a device with NO config — a provider that fails to
 * construct and says so — never two devices wearing each other's, which is the
 * state that reads as plausible and costs a day.
 */

import { LINKED_DEVICES_RESERVED_KEYS } from './device-linked-devices.js'
import type { DeviceManagerSettings } from './device-meta-store.js'
import { type OwnedCaps, splitRuntimeBlob } from './field-ownership.js'
import { MigrationRefusedError } from './migration-refused.js'

/** Legacy stream-profile assignment key (cf. `device-queries.ts`). */
const PROFILE_MAP_CONFIG_KEY = '_profileMap'

/** Config keys that belong to the camera's ROLE and stay with the number. */
const ROLE_SCOPED_CONFIG_KEYS: ReadonlySet<string> = LINKED_DEVICES_RESERVED_KEYS

/** The narrow settings slice the swap needs — the seam the spec fakes. */
export type HardwareStateStore = Pick<
  DeviceManagerSettings,
  | 'readDeviceStore'
  | 'writeDeviceStore'
  | 'clearDeviceStore'
  | 'readDeviceRuntimeState'
  | 'writeDeviceRuntimeState'
>

/** One config blob split by the rule above. */
interface ConfigSplit {
  readonly hardware: Record<string, unknown>
  readonly role: Record<string, unknown>
}

export interface SwappedHardwareState {
  /** Runtime-state blob now persisted at `sourceId` (was the target's). */
  readonly runtimeStateNowAtSource: Record<string, unknown>
  /** Runtime-state blob now persisted at `targetId` (was the source's). */
  readonly runtimeStateNowAtTarget: Record<string, unknown>
  /** Hardware config keys that moved target → source. */
  readonly hardwareKeysToSource: readonly string[]
  /** Hardware config keys that moved source → target. */
  readonly hardwareKeysToTarget: readonly string[]
  /** Role config keys that stayed on each number. */
  readonly roleKeysKeptAtSource: readonly string[]
  readonly roleKeysKeptAtTarget: readonly string[]
}

/** One claimed cap on a device that blocks its migration. */
export interface BlockingClaim {
  readonly cap: string
  readonly owner: string
  readonly fields: readonly string[]
}

/** A device whose row carries claims, and what they are. */
export interface ClaimBlockedDevice {
  readonly deviceId: number
  readonly claims: readonly BlockingClaim[]
}

/**
 * The refusal of a migration over a device under customization. `blocked`
 * carries the same facts as the message, per device, so the caller can log
 * one line per device tagged with its id.
 */
export class FieldClaimsBlockMigrationError extends Error {
  constructor(
    readonly sourceId: number,
    readonly targetId: number,
    readonly blocked: readonly ClaimBlockedDevice[],
  ) {
    super(
      `migration ${sourceId} → ${targetId} refused: ${describeBlocked(blocked)} — delete the ` +
        'customization before migrating (the composer releases its claims; then retry)',
    )
    this.name = 'FieldClaimsBlockMigrationError'
  }
}

/**
 * A claim that landed while the migration was already running (D663 final
 * review I-1). It passed the claim methods' migration gate just before the
 * migration began, and its write-through had not reached the row when
 * {@link assertNoFieldClaims} read it. Found after the drain, before any row
 * moved — so it is a {@link MigrationRefusedError}: both cameras' switches are
 * restored, and the claim stays on the number it names.
 */
export class ClaimLandedDuringMigrationError extends MigrationRefusedError {
  constructor(
    readonly sourceId: number,
    readonly targetId: number,
    readonly blocked: readonly ClaimBlockedDevice[],
  ) {
    super(
      `migration ${sourceId} → ${targetId} refused: ${describeBlocked(blocked)}, landed while ` +
        'the migration was starting — nothing moved; delete the customization, then retry',
    )
    this.name = 'ClaimLandedDuringMigrationError'
  }
}

function describeBlocked(blocked: readonly ClaimBlockedDevice[]): string {
  return blocked
    .map(({ deviceId, claims }) => {
      const named = claims.map((c) => `${c.cap} [${c.fields.join(', ')}]: ${c.owner}`).join(', ')
      return `device ${deviceId} has fields claimed by a customization (${named})`
    })
    .join('; ')
}

function blockingClaims(owned: OwnedCaps): readonly BlockingClaim[] {
  return [...owned].map(([cap, o]) => ({ cap, owner: o.owner, fields: [...o.fields] }))
}

/**
 * The second look, from MEMORY, once the mirror's writer is held and drained
 * (I-1). A claim is in the mirror from the moment it is accepted, before its
 * write-through lands, and the hold refuses any claim that reaches the mirror
 * after it — so an empty answer here means no claim can land on either row
 * until the swap is done.
 */
export function assertNoClaimLandedDuringMigration(
  ownedCapsOf: (deviceId: number) => OwnedCaps,
  sourceId: number,
  targetId: number,
): void {
  const blocked: ClaimBlockedDevice[] = []
  for (const deviceId of [sourceId, targetId]) {
    const owned = ownedCapsOf(deviceId)
    if (owned.size > 0) blocked.push({ deviceId, claims: blockingClaims(owned) })
  }
  if (blocked.length > 0) throw new ClaimLandedDuringMigrationError(sourceId, targetId, blocked)
}

/**
 * A claim names a NUMBER (`$owned` sits in `__device-state:<id>`); the block
 * that owns it names a STABLE ID; `swapIds` moves the stable id to the other
 * number. No swap of `$owned` keeps both keys right, so a device under
 * customization is not migratable (D663). Read from the ROW — claims are
 * written through, so the row is where one exists. A row that cannot be read
 * THROWS: an unknown answer must refuse, never read as "no claim" (D49).
 */
export async function assertNoFieldClaims(
  settings: Pick<HardwareStateStore, 'readDeviceRuntimeState'>,
  sourceId: number,
  targetId: number,
): Promise<void> {
  const blocked: ClaimBlockedDevice[] = []
  for (const deviceId of [sourceId, targetId]) {
    const { owned } = splitRuntimeBlob(await settings.readDeviceRuntimeState(deviceId))
    if (owned.size > 0) blocked.push({ deviceId, claims: blockingClaims(owned) })
  }
  if (blocked.length > 0) throw new FieldClaimsBlockMigrationError(sourceId, targetId, blocked)
}

function splitConfig(config: Record<string, unknown>): ConfigSplit {
  const hardware: Record<string, unknown> = {}
  const role: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (key === PROFILE_MAP_CONFIG_KEY) continue
    if (ROLE_SCOPED_CONFIG_KEYS.has(key)) role[key] = value
    else hardware[key] = value
  }
  return { hardware, role }
}

/**
 * Swap the hardware-scoped halves of two devices' persisted state. Runs right
 * after `swapIds`, under the same meta write lock. THROWS on failure: a
 * migration whose rows swapped but whose configs did not is exactly the
 * incident this module exists to prevent, and it must never be reported as a
 * success.
 */
export async function swapHardwareState(
  settings: HardwareStateStore,
  sourceId: number,
  targetId: number,
): Promise<SwappedHardwareState> {
  const sourceConfig = await settings.readDeviceStore(sourceId)
  const targetConfig = await settings.readDeviceStore(targetId)
  const source = splitConfig(sourceConfig)
  const target = splitConfig(targetConfig)

  // `writeDeviceStore` MERGES, so replace = clear + write. The clear also
  // drops `_profileMap`, which neither side carries forward.
  await settings.clearDeviceStore(sourceId)
  await settings.writeDeviceStore(sourceId, { ...target.hardware, ...source.role })
  await settings.clearDeviceStore(targetId)
  await settings.writeDeviceStore(targetId, { ...source.hardware, ...target.role })

  const sourceRuntimeState = await settings.readDeviceRuntimeState(sourceId)
  const targetRuntimeState = await settings.readDeviceRuntimeState(targetId)
  // `writeDeviceRuntimeState` replaces whole-blob by contract — no clear step.
  await settings.writeDeviceRuntimeState(sourceId, targetRuntimeState)
  await settings.writeDeviceRuntimeState(targetId, sourceRuntimeState)

  return {
    runtimeStateNowAtSource: targetRuntimeState,
    runtimeStateNowAtTarget: sourceRuntimeState,
    hardwareKeysToSource: Object.keys(target.hardware).toSorted(),
    hardwareKeysToTarget: Object.keys(source.hardware).toSorted(),
    roleKeysKeptAtSource: Object.keys(source.role).toSorted(),
    roleKeysKeptAtTarget: Object.keys(target.role).toSorted(),
  }
}
