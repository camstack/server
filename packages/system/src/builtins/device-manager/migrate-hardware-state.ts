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
 *  - A secret marker inside the swapped config names the keychain scope of ONE
 *    number (`secret://<owner>/device/<id>/<field>`; the ref is the AAD of the
 *    ciphertext). Swapping the marker alone left each number pointing at the
 *    other's scope, so removing either device purged the secret the other still
 *    used (D1093, live 2026-11-23). The configs swap with their markers
 *    unchanged (each still reads its value), then `repairCrossedSecretScopes`
 *    brings every value under the number whose config holds it, through staged
 *    copies, so a crash at any step is finished by a re-run of the repair.
 *  - The location (room) is role state and stays on the number (`swapIds`).
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

import {
  buildSecretRef,
  isSecretMarker,
  makeSecretMarker,
  parseSecretRef,
  type SecretRefParts,
  type SecretsAccess,
} from '@camstack/types'
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
  /** What happened to the keychain values the swapped config's markers name. */
  readonly secretScopes: SecretScopeReport
}

/** The keychain half of a swap, reported with the rest of it (never swallowed). */
export interface SecretScopeReport {
  /** The secrets were brought under their own numbers (false when nothing had to move). */
  readonly exchanged: boolean
  /** Markers in the swapped hardware config that were re-pointed at their new number. */
  readonly markersRepointed: number
  /** Refs now under `device/<sourceId>` (never values). */
  readonly refsAtSource: readonly string[]
  /** Refs now under `device/<targetId>` (never values). */
  readonly refsAtTarget: readonly string[]
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
  secrets: RepairSecretsDoor | undefined,
): Promise<SwappedHardwareState> {
  const sourceConfig = await settings.readDeviceStore(sourceId)
  const targetConfig = await settings.readDeviceStore(targetId)
  // Exchanging the scopes of a pair whose markers already name each other's
  // scope would mix the passwords; the pre-check refuses it before any row
  // moves, and this is the same refusal for a caller that skipped it.
  const crossed = [
    { deviceId: sourceId, markers: crossedIn(sourceConfig, targetId) },
    { deviceId: targetId, markers: crossedIn(targetConfig, sourceId) },
  ].filter((c) => c.markers > 0)
  if (crossed.length > 0) {
    // A plain Error, not the refusal class: the rows have already swapped here,
    // so this is "failed while moving", never "nothing moved".
    throw new Error(new SecretScopesCrossedError(sourceId, targetId, crossed).message)
  }
  const source = splitConfig(sourceConfig)
  const target = splitConfig(targetConfig)

  // The hardware config moves to the other number WITH its markers unchanged:
  // a marker names a keychain value by ref, so every marker keeps reading the
  // value it always read. What is left is the CROSSED shape (a number's config
  // names the other number's scope), which the repair below brings under the
  // right number crash-safely (the configs are its state machine).
  const marked =
    hasDeviceMarkers(source.hardware, sourceId, targetId) ||
    hasDeviceMarkers(target.hardware, sourceId, targetId)
  if (secrets === undefined && marked) {
    // Refused before a byte moved.
    throw new Error(
      `keychain door unavailable - devices ${sourceId} and ${targetId} hold keychain ` +
        'secrets and the migration cannot move them; nothing was changed',
    )
  }

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

  // Last: a failure in the repair leaves a state `repairMigrationSecrets`
  // finishes (every marker still reads its value, no value was removed early).
  let secretScopes: SecretScopeReport = {
    exchanged: false,
    markersRepointed: 0,
    refsAtSource: [],
    refsAtTarget: [],
  }
  if (marked) {
    try {
      const repaired = await repairCrossedSecretScopes(settings, secrets, sourceId, targetId, true)
      secretScopes = {
        exchanged: repaired.outcome === 'repaired',
        markersRepointed: repaired.markersRepointedAtA + repaired.markersRepointedAtB,
        refsAtSource: repaired.refsNowAtA,
        refsAtTarget: repaired.refsNowAtB,
      }
    } catch (err: unknown) {
      throw new Error(
        `migration: configs swapped but the secrets are not yet under their own numbers (${err instanceof Error ? err.message : String(err)}); ` +
          `every marker still reads its value - run deviceManager.repairMigrationSecrets { deviceA: ${sourceId}, deviceB: ${targetId}, apply: true }`,
        { cause: err },
      )
    }
  }

  return {
    runtimeStateNowAtSource: targetRuntimeState,
    runtimeStateNowAtTarget: sourceRuntimeState,
    hardwareKeysToSource: Object.keys(target.hardware).toSorted(),
    hardwareKeysToTarget: Object.keys(source.hardware).toSorted(),
    roleKeysKeptAtSource: Object.keys(source.role).toSorted(),
    roleKeysKeptAtTarget: Object.keys(target.role).toSorted(),
    secretScopes,
  }
}

/** What {@link repairCrossedSecretScopes} found and did. Refs only, never values. */
export interface SecretRepairReport {
  readonly outcome: 'repaired' | 'would-repair' | 'nothing-to-repair'
  /** Markers in A's config that name another number's scope (moved under A when applied). */
  readonly markersRepointedAtA: number
  /** Markers in B's config that name another number's scope (moved under B when applied). */
  readonly markersRepointedAtB: number
  readonly refsNowAtA: readonly string[]
  readonly refsNowAtB: readonly string[]
}

/** The keychain door the repair needs: `ctx.secrets.forOwner`, the in-process delegate. */
export interface RepairSecretsDoor {
  readonly forOwner: (owner: string) => Pick<SecretsAccess, 'resolve' | 'put' | 'delete'>
}

/** The suffix of the staging copy a repair keeps while a value changes scope. */
const REPAIR_STAGING_SUFFIX = '~repair'

/** One secret marker the repair has to bring back under its own number. */
interface RepairMarker {
  /** The ref the config names now. */
  readonly current: string
  /** The staging copy (the ref itself when a crashed run already staged it). */
  readonly staging: string
  /** The ref under the number the marker sits in: the end state. */
  readonly dest: string
  readonly owner: string
  /** True when `current` is already a staging copy of an earlier, interrupted run. */
  readonly staged: boolean
}

function refWithin(parts: SecretRefParts, deviceId: number, fieldPath: string): string {
  return buildSecretRef({ ...parts, scope: { kind: 'device', deviceId }, fieldPath })
}

/**
 * The markers of `config` (the config of `ownId`) the repair must move: those
 * naming `otherId`'s scope, and the staging copies of an interrupted run.
 */
function repairMarkers(
  config: Record<string, unknown>,
  ownId: number,
  otherId: number,
): readonly RepairMarker[] {
  const found: RepairMarker[] = []
  for (const current of collectMarkerRefs(config)) {
    const parts = parseSecretRef(current)
    if (parts === null || parts.scope.kind !== 'device') continue
    const staged = parts.fieldPath.endsWith(REPAIR_STAGING_SUFFIX)
    const crossed = parts.scope.deviceId === otherId
    if (!(crossed || (staged && parts.scope.deviceId === ownId))) continue
    const fieldPath = staged
      ? parts.fieldPath.slice(0, -REPAIR_STAGING_SUFFIX.length)
      : parts.fieldPath
    found.push({
      current,
      staging: staged ? current : refWithin(parts, ownId, `${fieldPath}${REPAIR_STAGING_SUFFIX}`),
      dest: refWithin(parts, ownId, fieldPath),
      owner: parts.owner,
      staged,
    })
  }
  return found
}

/**
 * Repair a pair a migration left with CROSSED secrets (it ran before the
 * secrets followed the config): a number's config carries markers naming the
 * OTHER number's keychain scope, so removing either device would purge the
 * secret the other still reads. Each such marker's value is brought under the
 * number whose config holds it.
 *
 * The configs ARE the state machine, so a crash at any step is re-run to the
 * right end state — never a double exchange, never a value lost:
 *  1. stage: copy each value to a staging ref in its own number's scope
 *     (idempotent puts; the originals are untouched);
 *  2. point both configs at the staging refs — from here every marker reads a
 *     value that is not about to be overwritten;
 *  3. put each value at its end ref (idempotent: the source is the staging ref);
 *  4. point both configs at the end refs;
 *  5. delete the staging refs and any original no config names any more.
 * A re-run reads each marker's CURRENT ref, so a marker already at a staging
 * or end ref continues from there. One-sided pairs and a pair where only some
 * fields are crossed work the same way, field by field.
 *
 * Idempotent: a pair with no marker to move is left alone. `apply: false` is
 * the dry run: counts only. A missing keychain door with markers to move THROWS.
 */
export async function repairCrossedSecretScopes(
  settings: Pick<HardwareStateStore, 'readDeviceStore' | 'writeDeviceStore'>,
  secrets: RepairSecretsDoor | undefined,
  deviceA: number,
  deviceB: number,
  apply: boolean,
): Promise<SecretRepairReport> {
  const configA = await settings.readDeviceStore(deviceA)
  const configB = await settings.readDeviceStore(deviceB)
  const markersA = repairMarkers(configA, deviceA, deviceB)
  const markersB = repairMarkers(configB, deviceB, deviceA)
  const counts = { markersRepointedAtA: markersA.length, markersRepointedAtB: markersB.length }
  if (markersA.length === 0 && markersB.length === 0) {
    return { outcome: 'nothing-to-repair', ...counts, refsNowAtA: [], refsNowAtB: [] }
  }
  if (secrets === undefined) {
    throw new Error(
      `repairMigrationSecrets: no keychain door on this node — devices ${deviceA} and ${deviceB} ` +
        'hold markers that must move; nothing was changed',
    )
  }
  if (!apply) return { outcome: 'would-repair', ...counts, refsNowAtA: [], refsNowAtB: [] }

  const all = [...markersA, ...markersB]
  const valueOf = async (owner: string, ref: string): Promise<string> => {
    const answer = (await secrets.forOwner(owner).resolve([ref]))[ref]
    if (answer?.kind === 'value') return answer.value
    throw new Error(
      `repairMigrationSecrets: ${ref} cannot be read (${answer?.kind ?? 'no answer'}); nothing was changed`,
    )
  }
  // A marker is moved by the config it sits in: the same ref can be a crossed
  // marker in one config and a legitimate own marker in the other.
  const rewritten = (
    pick: (m: RepairMarker) => string,
  ): readonly [Record<string, unknown>, Record<string, unknown>] => {
    const mapOf = (markers: readonly RepairMarker[]): ((ref: string) => string | undefined) => {
      const byCurrent = new Map(markers.map((m) => [m.current, pick(m)]))
      return (ref) => byCurrent.get(ref)
    }
    return [
      rewriteMarkerRefs(configA, mapOf(markersA)),
      rewriteMarkerRefs(configB, mapOf(markersB)),
    ]
  }
  const writeBoth = async (pick: (m: RepairMarker) => string): Promise<void> => {
    const [nextA, nextB] = rewritten(pick)
    await settings.writeDeviceStore(deviceA, nextA)
    await settings.writeDeviceStore(deviceB, nextB)
  }

  // 1. Every staging copy exists before any config or end ref moves.
  for (const m of all) {
    if (!m.staged) {
      await secrets.forOwner(m.owner).put(m.staging, await valueOf(m.owner, m.current))
    }
  }
  // 2. Both configs read staging copies: nothing names a cell about to be overwritten.
  await writeBoth((m) => m.staging)
  // 3. The end refs take the staged values.
  for (const m of all) {
    await secrets.forOwner(m.owner).put(m.dest, await valueOf(m.owner, m.staging))
  }
  // 4. Both configs name their own number's refs.
  await writeBoth((m) => m.dest)
  // 5. Staging copies and orphaned originals go; a failure here leaves only orphans.
  const finalRefs = new Set(rewritten((m) => m.dest).flatMap(collectMarkerRefs))
  for (const m of all) {
    const stale = [m.staging, ...(m.staged || finalRefs.has(m.current) ? [] : [m.current])]
    await secrets.forOwner(m.owner).delete(stale)
  }
  return {
    outcome: 'repaired',
    ...counts,
    refsNowAtA: markersA.map((m) => m.dest),
    refsNowAtB: markersB.map((m) => m.dest),
  }
}

/**
 * The refusal of a migration over a pair whose configs hold markers naming the
 * OTHER number's keychain scope (an earlier migration crossed them): swapping
 * again would mix the passwords. Nothing moved; run the repair first.
 */
export class SecretScopesCrossedError extends MigrationRefusedError {
  constructor(
    readonly sourceId: number,
    readonly targetId: number,
    readonly crossed: ReadonlyArray<{ readonly deviceId: number; readonly markers: number }>,
  ) {
    super(
      `secret-scopes-crossed: migration ${sourceId} → ${targetId} refused: ` +
        `${crossed.map((c) => `device ${c.deviceId} holds ${c.markers} secret marker(s) naming the other number's keychain scope`).join('; ')}` +
        ' — run deviceManager.repairMigrationSecrets first (nothing moved)',
    )
    this.name = 'SecretScopesCrossedError'
  }
}

/** True when `config` holds a marker in the keychain scope of device `a` or `b`. */
function hasDeviceMarkers(config: Record<string, unknown>, a: number, b: number): boolean {
  return collectMarkerRefs(config).some((ref) => {
    const parts = parseSecretRef(ref)
    return (
      parts !== null &&
      parts.scope.kind === 'device' &&
      (parts.scope.deviceId === a || parts.scope.deviceId === b)
    )
  })
}

function crossedIn(config: Record<string, unknown>, otherId: number): number {
  return collectMarkerRefs(config).filter((ref) => {
    const parts = parseSecretRef(ref)
    return parts !== null && parts.scope.kind === 'device' && parts.scope.deviceId === otherId
  }).length
}

/**
 * Refuse a migration when either config already names the other number's
 * keychain scope. Read from the stored configs (D49: an unreadable config
 * throws, never reads as "not crossed").
 */
export async function assertNoCrossedSecretScopes(
  settings: Pick<HardwareStateStore, 'readDeviceStore'>,
  sourceId: number,
  targetId: number,
): Promise<void> {
  const crossed = [
    { deviceId: sourceId, markers: crossedIn(await settings.readDeviceStore(sourceId), targetId) },
    { deviceId: targetId, markers: crossedIn(await settings.readDeviceStore(targetId), sourceId) },
  ].filter((c) => c.markers > 0)
  if (crossed.length > 0) throw new SecretScopesCrossedError(sourceId, targetId, crossed)
}

/** Every secret marker's ref in a config, at any depth. */
function collectMarkerRefs(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectMarkerRefs)
  if (isSecretMarker(value)) return [value.$secret]
  if (isRecord(value)) return Object.values(value).flatMap(collectMarkerRefs)
  return []
}

/** A copy of `value` whose markers name `map(ref)` where it answers (others untouched). */
function rewriteMarkerRefs(
  value: Record<string, unknown>,
  map: (ref: string) => string | undefined,
): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk)
    if (isSecretMarker(node)) return makeSecretMarker(map(node.$secret) ?? node.$secret)
    if (isRecord(node))
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]))
    return node
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
