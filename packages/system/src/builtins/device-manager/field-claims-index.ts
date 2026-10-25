/**
 * The claims INDEX (D663): which (device, cap) pairs carry a per-field claim,
 * by whom, in which mode, over which fields — one blob on the device-manager's
 * own settings store, key `field-claims-index`.
 *
 * It is a LISTING PROJECTION, not an authority (rulings D3/D62, preflight
 * §4-4): the merge authority is the device's row (`$owned`, `DeviceStateMirror`).
 * The index answers two questions the row cannot answer cheaply: "which devices
 * have claims at all?" (the boot seed asks it before reading any row — S6,
 * D447) and "list every claim" (`deviceState.listClaims`).
 *
 * Write order keeps it a SUPERSET of the rows' claims: written BEFORE the row on
 * a claim, AFTER the row on a release. A crash between the two leaves at worst
 * an index entry with no row claim — never a row claim the index misses, which
 * would let a claimed device seed without its row and answer the native for a
 * claimed field. Three conditions keep the projection honest: `removeDevice`
 * prunes it (`pruneDevice`); a `releaseClaim` that finds no claim on the row
 * removes the stale entry (the caller does that with `remove`); and D663 names
 * it a projection with this write order.
 *
 * It loads once at init and never on a timer (D3): until a load has SUCCEEDED,
 * `view()` is `not-loaded` (every seed reads its row, as before the index
 * existed) and `list()` says so with the reason — never `[]` (D315). A blob
 * that READS but does not PARSE is the same state: unknown, not empty (D49).
 * Each caller that needs it loaded asks `load` again; a failed read is retried
 * by the next call, not by a clock.
 */
import type { ClaimsListing, FieldClaim, IScopedLogger } from '@camstack/types'
import { FieldClaimSchema } from '@camstack/types'
import type { DeviceManagerSettings } from './device-meta-store.js'
import type { ClaimsIndexView } from './device-state-mirror.js'
import type { WriteLock } from './write-lock.js'

/** The addon-store key the index lives under. */
export const FIELD_CLAIMS_INDEX_KEY = 'field-claims-index'

/** One claim's identity in the index: a cap on a device has at most one owner. */
export interface ClaimKey {
  readonly deviceId: number
  readonly capName: string
}

/** A read-modify-write step over the loaded entries; null means nothing to write. */
export type IndexTransform = (
  current: ReadonlyMap<string, FieldClaim>,
) => ReadonlyMap<string, FieldClaim> | null

export interface FieldClaimsIndexDeps {
  readonly logger: IScopedLogger
  /**
   * The addon's own settings row-set lock, shared with every other writer of
   * it: `writeAddonStore` is a read-modify-write of the WHOLE key range on the
   * store side, so unordered writers destroy each other's keys.
   */
  readonly withAddonStoreWriteLock: WriteLock
}

function keyOf(key: ClaimKey): string {
  return `${key.deviceId}/${key.capName}`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class FieldClaimsIndex {
  /** The loaded entries by key, or null until a load has succeeded. */
  private entries: ReadonlyMap<string, FieldClaim> | null = null
  /** Devices with at least one entry — what the seed asks, per native write. */
  private claimedDevices: ReadonlySet<number> = new Set()
  /** Why the last load did not succeed. */
  private notLoadedReason = 'not loaded yet'
  /** One load in flight at a time; concurrent callers join it. */
  private loading: Promise<boolean> | null = null

  constructor(private readonly deps: FieldClaimsIndexDeps) {}

  /**
   * Load the blob. Resolves `true` once the index is loaded (now or already);
   * `false` when the store could not answer — the reason is kept for `list`.
   * Never throws: an index that cannot load is a state, not a failure.
   */
  load(settings: DeviceManagerSettings): Promise<boolean> {
    if (this.entries !== null) return Promise.resolve(true)
    if (this.loading) return this.loading
    const run = this.readBlob(settings).finally(() => {
      this.loading = null
    })
    this.loading = run
    return run
  }

  /** What the seed consults: loaded with a device predicate, or not loaded. */
  view(): ClaimsIndexView {
    if (this.entries === null) return { state: 'not-loaded' }
    const claimed = this.claimedDevices
    return { state: 'loaded', hasClaims: (deviceId) => claimed.has(deviceId) }
  }

  /** Every entry, optionally those whose owner starts with `ownerPrefix`; or why there is no answer. */
  list(ownerPrefix?: string): ClaimsListing {
    if (this.entries === null) return { state: 'not-loaded', reason: this.notLoadedReason }
    const claims = [...this.entries.values()].filter(
      (c) => ownerPrefix === undefined || c.owner.startsWith(ownerPrefix),
    )
    return { state: 'loaded', claims }
  }

  /** The entry for a key, when the index is loaded and has one. */
  entry(key: ClaimKey): FieldClaim | undefined {
    return this.entries?.get(keyOf(key))
  }

  /** Add or replace one entry — written before the row it announces. Throws when the index cannot be loaded or written. */
  async upsert(claim: FieldClaim, settings: DeviceManagerSettings): Promise<void> {
    await this.mutate(settings, claim.deviceId, (current) => {
      const next = new Map(current)
      next.set(keyOf(claim), { ...claim, fields: [...claim.fields] })
      return next
    })
  }

  /** Remove one entry — written after the row no longer carries the claim. No write when absent. */
  async remove(key: ClaimKey, settings: DeviceManagerSettings): Promise<void> {
    await this.mutate(settings, key.deviceId, (current) => {
      if (!current.has(keyOf(key))) return null
      const next = new Map(current)
      next.delete(keyOf(key))
      return next
    })
  }

  /**
   * Drop every entry of a removed device (condition i). Best effort: an index
   * that cannot be loaded or written keeps a stale entry, which costs the next
   * seed of that number one row read and is removed by the next release that
   * answers `not-claimed` — so it is logged, never thrown, and the removal
   * proceeds.
   */
  async pruneDevice(deviceId: number, settings: DeviceManagerSettings): Promise<void> {
    try {
      await this.mutate(settings, deviceId, (current) => {
        const kept = [...current].filter(([, c]) => c.deviceId !== deviceId)
        return kept.length === current.size ? null : new Map(kept)
      })
    } catch (err: unknown) {
      this.deps.logger.warn(
        'claims index not pruned for a removed device — a stale entry stays until the next release',
        { tags: { deviceId }, meta: { error: errorMessage(err) } },
      )
    }
  }

  /**
   * Read-modify-write of the whole blob under the addon-store lock, from the
   * LOADED entries: the index is never written from a partial picture. `next`
   * returning null means nothing to write.
   */
  private async mutate(
    settings: DeviceManagerSettings,
    deviceId: number,
    next: IndexTransform,
  ): Promise<void> {
    await this.deps.withAddonStoreWriteLock(async () => {
      if (!(await this.load(settings))) {
        throw new Error(
          `claims index not loaded (${this.notLoadedReason}) — refusing to write it blind`,
        )
      }
      const current = this.entries ?? new Map<string, FieldClaim>()
      const updated = next(current)
      if (updated === null) return
      try {
        await settings.writeAddonStore({ [FIELD_CLAIMS_INDEX_KEY]: [...updated.values()] })
      } catch (err: unknown) {
        this.deps.logger.warn('claims index write failed — index unchanged', {
          tags: { deviceId },
          meta: { error: errorMessage(err) },
        })
        throw err
      }
      this.install(updated)
    })
  }

  private install(entries: ReadonlyMap<string, FieldClaim>): void {
    this.entries = entries
    this.claimedDevices = new Set([...entries.values()].map((c) => c.deviceId))
  }

  /** The three-way read (D651): a failed read is a REASON, never an empty index. */
  private async readBlob(settings: DeviceManagerSettings): Promise<boolean> {
    if (settings.readAddonStoreResult === undefined) {
      this.notLoadedReason = 'this settings view predates the three-way addon-store read'
      return false
    }
    let read: Awaited<ReturnType<NonNullable<DeviceManagerSettings['readAddonStoreResult']>>>
    try {
      read = await settings.readAddonStoreResult()
    } catch (err: unknown) {
      read = { kind: 'failed', error: errorMessage(err) }
    }
    if (read.kind === 'failed') {
      this.notLoadedReason = `addon store unreadable: ${read.error}`
      this.deps.logger.warn('claims index not loaded — every seed reads its row until it is', {
        meta: { error: read.error },
      })
      return false
    }
    const raw = read.kind === 'value' ? read.value[FIELD_CLAIMS_INDEX_KEY] : undefined
    // A blob that is on the store but malformed is UNKNOWN, never "no claims"
    // (D49): a dropped entry could be the very device that is claimed, and a
    // loaded index that omits it would let its next native write erase `$owned`
    // from the row. Every seed reads its row until an operator repairs the blob.
    if (raw !== undefined && !Array.isArray(raw)) {
      return this.refuseMalformed(`claims index blob malformed: not a list (${typeof raw})`)
    }
    const entries = new Map<string, FieldClaim>()
    const dropped: number[] = []
    for (const [i, item] of (raw ?? []).entries()) {
      const parsed = FieldClaimSchema.safeParse(item)
      if (parsed.success) entries.set(keyOf(parsed.data), parsed.data)
      else dropped.push(i)
    }
    if (dropped.length > 0) {
      return this.refuseMalformed(
        `claims index blob malformed at positions ${dropped.join(', ')} — repair the ` +
          `'${FIELD_CLAIMS_INDEX_KEY}' key of the device-manager store`,
      )
    }
    this.install(entries)
    return true
  }

  /** Not loaded, by name: the index stays unknown and says why. */
  private refuseMalformed(reason: string): false {
    this.notLoadedReason = reason
    this.deps.logger.warn('claims index not loaded — every seed reads its row until it is', {
      meta: { reason },
    })
    return false
  }
}
