/**
 * The identifier INDEX (planning#593): identifier key → devices, so the
 * device-manager can say which devices of DIFFERENT integrations share
 * provider-declared identifiers (D1059) without reading the fleet per question.
 *
 * It is a PROJECTION of the device rows, never an authority: it holds, per
 * device, only what the pair rule needs — owning addon, integration instance and
 * the declared identifiers — and it moves with the rows, as the
 * {@link DeviceRowObserver} of the one `DeviceRowStore`. Every write of a row
 * passes through that store (`upsert`, `upsertRegistration`, `patch`, `remove`;
 * `swapIds` is built of them), so a row that changes reaches the index on the
 * same statement. A deleted device leaves the index on its row's DELETE — the
 * statement `removeDevice` runs right before it records the tombstone (D865) —
 * not on an event or on absence from a listing.
 *
 * It loads once, from the fleet listing the device-manager already reads at
 * boot ({@link seed}). Until then it answers `unknown` (D315), never `[]`; a row
 * write that lands while the snapshot is in flight is buffered and replayed over
 * it, so the seed can never roll a newer write back.
 *
 * Read-only: it finds candidates, it links nothing (that is step 3).
 */
import {
  DEVICE_IDENTIFIER_KEYS,
  identifierStrength,
  type DeviceIdentifierKey,
  type DeviceIdentifiers,
  type IdentityCandidateDevice,
  type IdentityCandidatePair,
  type IdentityCandidates,
  type IdentityConfidence,
  type IdentityMatchedKey,
} from '@camstack/types'
import type { PersistedDeviceMeta } from './device-meta-types.js'
import type { DeviceRegistrationRow, DeviceRow, DeviceRowPatch } from './device-row-store.js'

/** What the row store tells its observer, after each statement succeeded. */
export interface DeviceRowObserver {
  /** A whole row was written (`upsert`). */
  rowWritten(meta: PersistedDeviceMeta): void
  /** The registration columns were written (`upsertRegistration`) — insert or update. */
  registrationWritten(row: DeviceRegistrationRow): void
  /** Named columns of an existing row were written (`patch`). */
  rowPatched(deviceId: number, patch: DeviceRowPatch): void
  /** The row was deleted (`remove`). */
  rowRemoved(deviceId: number): void
}

/** What the index keeps per device. */
interface IndexedDevice {
  readonly deviceId: number
  readonly addonId: string
  readonly integrationId: string | null
  readonly identifiers: DeviceIdentifiers | null
}

type BufferedWrite = (index: DeviceIdentityIndex) => void

/** The `kind=value` keys of one declaration. */
function keysOf(identifiers: DeviceIdentifiers | null): readonly string[] {
  if (identifiers === null) return []
  const out: string[] = []
  for (const kind of DEVICE_IDENTIFIER_KEYS) {
    const entry = identifiers[kind]
    if (entry === undefined) continue
    for (const e of [entry].flat()) out.push(`${kind}=${e.value}`)
  }
  return out
}

function isIdentifierKind(value: string): value is DeviceIdentifierKey {
  return DEVICE_IDENTIFIER_KEYS.some((k) => k === value)
}

function parseKey(key: string): IdentityMatchedKey | null {
  const at = key.indexOf('=')
  const kind = key.slice(0, at)
  return isIdentifierKind(kind) ? { key: kind, value: key.slice(at + 1) } : null
}

/**
 * Same integration? The same instance when both carry one; otherwise — one side
 * was never stamped — the same addon. In doubt, the same: no candidate.
 */
function sameIntegration(a: IndexedDevice, b: IndexedDevice): boolean {
  if (a.integrationId !== null && b.integrationId !== null) {
    return a.integrationId === b.integrationId
  }
  return a.addonId === b.addonId
}

function sideOf(d: IndexedDevice): IdentityCandidateDevice {
  return { deviceId: d.deviceId, addonId: d.addonId, integrationId: d.integrationId }
}

function compareKeys(x: IdentityMatchedKey, y: IdentityMatchedKey): number {
  if (x.key !== y.key) return x.key < y.key ? -1 : 1
  return x.value < y.value ? -1 : x.value > y.value ? 1 : 0
}

/**
 * Grade the keys two devices share. `null` when they are no candidate at all
 * (no strong key matched).
 *
 * | Matched keys                              | Confidence   |
 * | ----------------------------------------- | ------------ |
 * | two strong KINDS (e.g. `mac` + `serial`)  | `auto`       |
 * | `mac` + `ip`                              | `auto`       |
 * | exactly one strong kind                   | `proposal`   |
 * | weak keys only (`hostname`, `ip`)         | no candidate |
 *
 * Strength counts distinct KINDS, not values: two MACs of one device matching
 * the other's two MACs are one kind of evidence, so a proposal.
 */
export function classifyIdentityMatch(
  keys: readonly IdentityMatchedKey[],
): IdentityConfidence | null {
  const kinds: ReadonlySet<DeviceIdentifierKey> = new Set(keys.map((k) => k.key))
  const strongKinds = [...kinds].filter((kind) => identifierStrength(kind) === 'strong')
  if (strongKinds.length === 0) return null
  if (strongKinds.length >= 2) return 'auto'
  if (kinds.has('mac') && kinds.has('ip')) return 'auto'
  return 'proposal'
}

export class DeviceIdentityIndex implements DeviceRowObserver {
  private readonly devices = new Map<number, IndexedDevice>()
  private readonly byKey = new Map<string, Set<number>>()
  /** `null` once seeded; until then, the writes to replay over the snapshot. */
  private pending: BufferedWrite[] | null = []

  /** Load from a fleet snapshot, then replay every write that landed meanwhile. */
  seed(rows: readonly DeviceRow[]): void {
    const buffered = this.pending ?? []
    this.pending = null
    this.devices.clear()
    this.byKey.clear()
    for (const row of rows) this.rowWritten(row.meta)
    for (const write of buffered) write(this)
  }

  rowWritten(meta: PersistedDeviceMeta): void {
    if (this.buffer((i) => i.rowWritten(meta))) return
    this.put({
      deviceId: meta.id,
      addonId: meta.addonId,
      integrationId: meta.integrationId ?? null,
      identifiers: meta.identifiers ?? null,
    })
  }

  registrationWritten(row: DeviceRegistrationRow): void {
    if (this.buffer((i) => i.registrationWritten(row))) return
    const existing = this.devices.get(row.deviceId)
    this.put({
      deviceId: row.deviceId,
      addonId: row.addonId,
      integrationId: existing?.integrationId ?? null,
      identifiers: existing?.identifiers ?? null,
    })
  }

  rowPatched(deviceId: number, patch: DeviceRowPatch): void {
    if (patch.identifiers === undefined && patch.integrationId === undefined) return
    if (this.buffer((i) => i.rowPatched(deviceId, patch))) return
    const existing = this.devices.get(deviceId)
    // A patch is an UPDATE: a row the index does not know does not exist.
    if (existing === undefined) return
    this.put({
      ...existing,
      ...(patch.identifiers !== undefined ? { identifiers: patch.identifiers } : {}),
      ...(patch.integrationId !== undefined ? { integrationId: patch.integrationId } : {}),
    })
  }

  rowRemoved(deviceId: number): void {
    if (this.buffer((i) => i.rowRemoved(deviceId))) return
    this.drop(deviceId)
  }

  /**
   * Every cross-integration candidate pair, graded by `classifyIdentityMatch`,
   * plus the devices whose identity is unknown (nothing declared).
   */
  candidates(): IdentityCandidates {
    if (this.pending !== null) {
      return { status: 'unknown', reason: 'the identifier index has not loaded yet' }
    }
    const seen = new Set<string>()
    const pairs: IdentityCandidatePair[] = []
    for (const [key, members] of this.byKey) {
      const parsed = parseKey(key)
      if (parsed === null || identifierStrength(parsed.key) !== 'strong') continue
      if (members.size < 2) continue
      const sorted = [...members].sort((x, y) => x - y)
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const pair = this.pairOf(sorted[i], sorted[j], seen)
          if (pair !== null) pairs.push(pair)
        }
      }
    }
    pairs.sort((x, y) => x.a.deviceId - y.a.deviceId || x.b.deviceId - y.b.deviceId)
    const undeclaredDeviceIds = [...this.devices.values()]
      .filter((d) => d.identifiers === null)
      .map((d) => d.deviceId)
      .sort((x, y) => x - y)
    return { status: 'answered', pairs, undeclaredDeviceIds }
  }

  private pairOf(
    idA: number | undefined,
    idB: number | undefined,
    seen: Set<string>,
  ): IdentityCandidatePair | null {
    if (idA === undefined || idB === undefined) return null
    const tag = `${idA}/${idB}`
    if (seen.has(tag)) return null
    seen.add(tag)
    const a = this.devices.get(idA)
    const b = this.devices.get(idB)
    if (a === undefined || b === undefined || sameIntegration(a, b)) return null
    const bKeys = new Set(keysOf(b.identifiers))
    const keys = keysOf(a.identifiers)
      .filter((k) => bKeys.has(k))
      .map(parseKey)
      .filter((k): k is IdentityMatchedKey => k !== null)
      .sort(compareKeys)
    const confidence = classifyIdentityMatch(keys)
    return confidence === null ? null : { a: sideOf(a), b: sideOf(b), keys, confidence }
  }

  /** True when the write was buffered for replay over a seed still in flight. */
  private buffer(write: BufferedWrite): boolean {
    if (this.pending === null) return false
    this.pending.push(write)
    return true
  }

  private put(device: IndexedDevice): void {
    this.drop(device.deviceId)
    this.devices.set(device.deviceId, device)
    for (const key of keysOf(device.identifiers)) {
      const members = this.byKey.get(key) ?? new Set<number>()
      members.add(device.deviceId)
      this.byKey.set(key, members)
    }
  }

  private drop(deviceId: number): void {
    const existing = this.devices.get(deviceId)
    if (existing === undefined) return
    this.devices.delete(deviceId)
    for (const key of keysOf(existing.identifiers)) {
      const members = this.byKey.get(key)
      if (members === undefined) continue
      members.delete(deviceId)
      if (members.size === 0) this.byKey.delete(key)
    }
  }
}
