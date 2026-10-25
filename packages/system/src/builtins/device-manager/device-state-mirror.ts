/**
 * Hub-side runtime-state mirror for the device-manager addon.
 *
 * `DeviceStateMirror` owns the per-device cap-keyed slice mirror and the
 * debounced disk-write coalescer. It mirrors every `deviceState.setCapSlice`
 * write, emits `DeviceStateChanged`, and coalesces frequent writes into one
 * `writeDeviceRuntimeState` per debounce window.
 *
 * It used to do one more thing: overlay each emitted slice with cross-device
 * LINKED values, walk a `linkDependents` reverse-index and re-emit for every
 * dependent target, guarded by a `lastEmittedOverlay` churn map. Wiring was
 * deleted on 2026-08-08 (0 links across 302 devices), so the mirror emits what
 * the provider wrote — one writer per field, which is what D62 asks for
 * everywhere else.
 *
 * ── Per-field claims (D663) ────────────────────────────────────────────────
 * A composition may CLAIM fields of a cap on an existing device. The provider
 * keeps writing; `stateMirror` keeps its slice as the NATIVE SHADOW, and what
 * is read and emitted for a claimed cap is the MERGE (`ClaimViews`). A device
 * with no claims never touches any of this: same slices, same events, same row.
 * Claims live in the device's own row under `$owned`, written THROUGH (rolled
 * back in memory when the write fails and nothing newer landed in its window);
 * owned values follow the native debounce and effective-change gate. Every row
 * write of a device — debounced, write-through, shutdown flush — goes through
 * ONE queue per device (`MirrorRowWriter`, `mirror-row-writer.ts`), so two
 * writes are never in flight at once and each carries the memory of the moment
 * it runs. The shadow reaches
 * the owner alone — `nativeSlice` and `DeviceNativeShadowChanged`, a category
 * the public routers refuse (D224).
 */
import { randomUUID } from 'node:crypto'
import type { AddonContext, ClaimOutcome, DeviceStatus } from '@camstack/types'
import {
  DeviceStatusSchema,
  deviceStatusCapability,
  EventCategory,
  runtimeStatePolicyFor,
} from '@camstack/types'
import type { DeviceManagerSettings } from './device-meta-store.js'
import { RunningFlipDetector } from './running-flip.js'
import { shallowEqual } from './device-projection.js'
import {
  ClaimViews,
  defaultSchemaFor,
  refused,
  type RuntimeStateSchemaLookup,
  sameOwnedCap,
} from './device-state-claim-views.js'
import {
  isPlainRecord,
  joinRuntimeBlob,
  type MergedSlice,
  OWNED_FIELDS_KEY,
  type OwnedCap,
  type OwnedCaps,
  splitRuntimeBlob,
} from './field-ownership.js'
import { MirrorRowWriter, type MirrorWriteHold } from './mirror-row-writer.js'
import {
  persistableBlob,
  type RuntimeStatePolicyLookup,
  sliceEffectivelyEqual,
} from './runtime-state-persist-gate.js'

const RUNNING_STATE_CAP = 'running-state'

/**
 * What the seed consults first: the claims index (Task 6). It is written
 * BEFORE the row, so a loaded index is a superset of the rows' claims and a
 * device it does not name has nothing to merge — no row read (D447).
 */
export type ClaimsIndexView =
  | { readonly state: 'loaded'; hasClaims(deviceId: number): boolean }
  | { readonly state: 'not-loaded' }

/**
 * How `seedMirror` treats what memory already holds. `fill` (boot, first
 * write) only adds caps memory lacks — memory is never behind the row.
 * `replace` (the migration reseed) drops the device's slices, claims and views
 * first: the row now describes different hardware, so everything memory held
 * under that number is the wrong device's state.
 */
export type SeedMode = 'fill' | 'replace'

/** What a failed write-through names in its log line. */
interface WriteThroughOp {
  readonly op: 'claim' | 'release'
  readonly cap: string
  readonly owner: string
}

/**
 * Undo what a failed write-through put in memory — IF it is still there. Answers
 * whether it rolled back: `false` means a newer same-owner state landed in the
 * write's window and stands (D49, D663 re-review N-4).
 */
type ConditionalRollback = () => boolean

const SEED_REFUSAL_MESSAGE = 'runtime-state row unreadable — native write refused until it reads'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class DeviceStateMirror {
  /**
   * Hub-side mirror of every device's cap-keyed NATIVE runtime state — what the
   * provider wrote. Key: deviceId. Value: per-cap slice map. Empty by default —
   * slices show up as `setCapSlice` calls trickle in.
   */
  private readonly stateMirror = new Map<number, Map<string, Record<string, unknown>>>()

  /** The claims and the merged view of every claimed cap (D663). */
  private readonly claims: ClaimViews

  /**
   * Devices whose CLAIMS are known: the row was read, or a loaded claims index
   * vouched that it names none (D447). This is a READ-path fact — what a
   * status read may answer from. It never licenses a row write (D677).
   */
  private readonly seeded = new Set<number>()
  /**
   * Devices whose row was actually READ into memory in THIS process. Every row
   * write of a device requires it (D677): the write replaces the whole row, so
   * memory must hold what the row held — an index that vouches for the claims
   * says nothing about the native slices beside them.
   */
  private readonly rowRead = new Set<number>()
  /** One row read per device, however many writes arrive during it. */
  private readonly seeding = new Map<number, Promise<void>>()
  /** Devices whose seed refusal is already logged — once per transition. */
  private readonly seedRefusalLogged = new Set<number>()

  /** Every write of a device's row, and what is believed to be on it. */
  private readonly writer: MirrorRowWriter

  /** Edge detector for `running-state` flip events (D933). */
  private readonly runningFlip = new RunningFlipDetector()

  constructor(
    private readonly ctx: AddonContext,
    /**
     * Per-cap durability + volatile-field policy. Defaults to the codegen'd
     * projection of every `*.cap.ts` (D4: the cap declares, the kernel reads).
     * Injectable so a spec can exercise the gate without the real cap set.
     */
    private readonly policyFor: RuntimeStatePolicyLookup = runtimeStatePolicyFor,
    /** The cap's `runtimeState` schema a merged slice is parsed with (D663). */
    schemaFor: RuntimeStateSchemaLookup = defaultSchemaFor,
  ) {
    this.claims = new ClaimViews({
      logger: ctx.logger,
      schemaFor,
      emitSlice: (deviceId, capName, slice) => this.emitStateChanged(deviceId, capName, slice),
    })
    this.writer = new MirrorRowWriter({
      logger: ctx.logger,
      policyFor,
      persistableFor: (deviceId) => this.persistableForDevice(deviceId),
      isRowRead: (deviceId) => this.rowRead.has(deviceId),
      readRowFirst: (deviceId, settings) => this.ensureRowRead(deviceId, settings),
    })
  }

  /**
   * Single-cap mirror update — diff against the current mirror,
   * persist the new slice in-memory, emit `DeviceStateChanged` for
   * this cap. No-op on identical writes (both same shape and same
   * values). Called by `setCapSlice` provider.
   *
   * This is the NATIVE path, unchanged for every writer. Under a claim the
   * native slice is stored as the shadow and what is emitted is the merge.
   *
   * @returns whether the mirror actually changed. The caller uses this to
   *   decide whether the (synchronous, disk-blocking) runtime-state write is
   *   worth scheduling — see `scheduleRuntimeStateDiskWrite`. Returning void
   *   here and scheduling unconditionally is what made an unchanged poll cost
   *   a SQLite commit.
   */
  applySingleCapUpdate(deviceId: number, capName: string, slice: Record<string, unknown>): boolean {
    let perCap = this.stateMirror.get(deviceId)
    if (!perCap) {
      perCap = new Map()
      this.stateMirror.set(deviceId, perCap)
    }
    const prior = perCap.get(capName)
    if (prior && shallowEqual(prior, slice)) return false
    perCap.set(capName, { ...slice })
    const claim = this.claims.claim(deviceId, capName)
    if (claim) {
      // The native changed; consumers see the merge over it, emitted whenever
      // the native moved (a clock advancing is how a refresh is detected), never
      // while held. The owner alone learns the native, on its own category
      // (D224), held or not — its derived fields depend on it either way.
      if (claim.mode === 'replace') this.emitNativeShadow(deviceId, capName, { ...slice })
      this.claims.recompute(deviceId, capName, claim, { ...slice }, /* emitUnchanged */ true)
      return true
    }
    this.emitStateChanged(deviceId, capName, { ...slice })
    return true
  }

  // ── Claims (D663) ──────────────────────────────────────────────────────────

  /**
   * Claim `cap.fields` of `capName` on `deviceId` for `cap.owner`. Written
   * through: resolves after the row write. A re-claim by the same owner
   * replaces `fields`; values of fields no longer claimed are dropped and the
   * native shows for them (ruling S1b). An empty `fields` is what the composer
   * never sends — it releases — and is refused.
   */
  async claim(
    deviceId: number,
    capName: string,
    cap: OwnedCap,
    settings: DeviceManagerSettings,
  ): Promise<ClaimOutcome> {
    if (cap.fields.length === 0) {
      return refused('invalid-slice', 'claim at least one field or release')
    }
    const outside = Object.keys(cap.values).filter((k) => !cap.fields.includes(k))
    if (outside.length > 0) {
      return refused(
        'field-not-claimed',
        `values name fields outside the claim: ${outside.join(', ')}`,
      )
    }
    const unreadable = await this.readRowOrRefuse(deviceId, settings)
    if (unreadable) return unreadable
    // A migration holds the row: this claim passed the migration gate before
    // it began, and landing now would ride the swap to the other number
    // (D663 final review I-1). From here to `setClaim` is synchronous, so a
    // claim is either in memory before the hold's second look, or refused.
    if (this.writer.isHeld(deviceId)) {
      this.ctx.logger.warn('claim refused — a migration holds the device row', {
        tags: { deviceId },
        meta: { cap: capName, owner: cap.owner },
      })
      return refused(
        'migration-in-flight',
        `device ${deviceId} is being migrated — its row is about to be swapped; retry once the migration is over`,
      )
    }
    const existing = this.claims.claim(deviceId, capName)
    if (existing && existing.owner !== cap.owner) {
      return refused(
        'owned-by-other',
        `${capName} on device ${deviceId} is claimed by ${existing.owner}`,
      )
    }
    const kept: Record<string, unknown> = {}
    if (existing) {
      for (const f of cap.fields) {
        if (Object.hasOwn(existing.values, f)) kept[f] = existing.values[f]
      }
    }
    const next: OwnedCap = {
      owner: cap.owner,
      mode: cap.mode,
      fields: [...cap.fields],
      values: { ...kept, ...cap.values },
    }
    // `changed: false` is a statement about the ROW, not about memory: a claim
    // whose write failed, or whose patch is still in its debounce window, is in
    // memory and not on disk — repeating it must write (I-4).
    if (
      existing &&
      sameOwnedCap(existing, next) &&
      this.isClaimPersisted(deviceId, capName, next)
    ) {
      return { ok: true, changed: false }
    }
    const prevView = this.claims.view(deviceId, capName)
    this.claims.setClaim(deviceId, capName, next)
    // Readers see the claim from the moment it is accepted (S5, N-5) — held or
    // merged, never the native for the row round-trip. Nothing is emitted yet.
    this.claims.previewView(deviceId, capName, next, this.nativeOf(deviceId, capName))
    await this.writeThrough(
      deviceId,
      settings,
      { op: 'claim', cap: capName, owner: cap.owner },
      () => {
        // Roll back only what THIS claim put there (D49): a same-owner patch
        // that landed in the window is a newer truth the owner was told about.
        if (this.claims.claim(deviceId, capName) !== next) return false
        if (existing) {
          this.claims.setClaim(deviceId, capName, existing)
          this.claims.restoreView(deviceId, capName, prevView)
        } else {
          this.claims.deleteClaim(deviceId, capName)
        }
        return true
      },
    )
    // What memory holds NOW — a patch in the window may have moved it past
    // `next`, a release may have removed it (that release emitted). The emit is
    // judged against what consumers LAST SAW, not against the preview.
    const current = this.claims.claim(deviceId, capName)
    if (current) {
      this.claims.restoreView(deviceId, capName, prevView)
      this.claims.recompute(deviceId, capName, current, this.nativeOf(deviceId, capName), false)
    }
    return { ok: true, changed: true }
  }

  /** Is this exact claim what the row carries, per `lastPersisted`? */
  private isClaimPersisted(deviceId: number, capName: string, claim: OwnedCap): boolean {
    const onDisk = this.writer.persisted(deviceId)?.[OWNED_FIELDS_KEY]?.[capName]
    const expected = joinRuntimeBlob({}, new Map([[capName, claim]]), this.policyFor)[
      OWNED_FIELDS_KEY
    ]?.[capName]
    if (!isPlainRecord(onDisk) || !isPlainRecord(expected)) return false
    return sliceEffectivelyEqual(onDisk, expected, [])
  }

  /**
   * Write owned values. Partial patches MERGE into `values` (ruling S5); a key
   * outside `fields` is refused. Debounced like a native slice.
   */
  async patchOwned(
    deviceId: number,
    capName: string,
    owner: string,
    values: Readonly<Record<string, unknown>>,
    settings: DeviceManagerSettings,
  ): Promise<ClaimOutcome> {
    // The claim may so far exist only on the row (hub restart): row first.
    const unreadable = await this.readRowOrRefuse(deviceId, settings)
    if (unreadable) return unreadable
    const existing = this.claims.claim(deviceId, capName)
    if (!existing) return refused('not-claimed', `${capName} on device ${deviceId} has no claim`)
    if (existing.owner !== owner) {
      return refused(
        'owned-by-other',
        `${capName} on device ${deviceId} is claimed by ${existing.owner}`,
      )
    }
    const outside = Object.keys(values).filter((k) => !existing.fields.includes(k))
    if (outside.length > 0) {
      return refused('field-not-claimed', `not in the claim on ${capName}: ${outside.join(', ')}`)
    }
    const next: OwnedCap = { ...existing, values: { ...existing.values, ...values } }
    if (sameOwnedCap(existing, next)) return { ok: true, changed: false }
    this.claims.setClaim(deviceId, capName, next)
    this.claims.recompute(deviceId, capName, next, this.nativeOf(deviceId, capName), false)
    this.writer.schedule(deviceId, settings, capName)
    return { ok: true, changed: true }
  }

  /**
   * Remove the claim. A `replace` hands the cap back: the native slice is
   * emitted exactly as last written. An `add` had no native — the cap leaves
   * the mirror and nothing is emitted (consumer mirrors keep the last value
   * until they re-read; recorded for Task 15). Written through.
   */
  async release(
    deviceId: number,
    capName: string,
    owner: string,
    settings: DeviceManagerSettings,
  ): Promise<ClaimOutcome> {
    // `not-claimed` from an unread row would leave a zombie claim on disk: row first.
    const unreadable = await this.readRowOrRefuse(deviceId, settings)
    if (unreadable) return unreadable
    const existing = this.claims.claim(deviceId, capName)
    if (!existing) return refused('not-claimed', `${capName} on device ${deviceId} has no claim`)
    if (existing.owner !== owner) {
      return refused(
        'owned-by-other',
        `${capName} on device ${deviceId} is claimed by ${existing.owner}`,
      )
    }
    const prevView = this.claims.view(deviceId, capName)
    this.claims.deleteClaim(deviceId, capName)
    await this.writeThrough(deviceId, settings, { op: 'release', cap: capName, owner }, () => {
      // A claim made in the window (a re-claim) is a newer truth: never
      // resurrect the released one over it (D49, N-4).
      if (this.claims.claim(deviceId, capName) !== undefined) return false
      this.claims.setClaim(deviceId, capName, existing)
      this.claims.restoreView(deviceId, capName, prevView)
      return true
    })
    // A re-claim landed in the window: the cap is claimed again, and that
    // claim's own write emits its merge. Handing the native to consumers now
    // would show them a slice a standing claim overrides.
    if (this.claims.claim(deviceId, capName) !== undefined) return { ok: true, changed: true }
    const native = this.nativeOf(deviceId, capName)
    if (existing.mode === 'replace' && native) {
      this.emitStateChanged(deviceId, capName, { ...native })
    } else if (existing.mode === 'replace') {
      // Accepted work that produced nothing says so (D391).
      this.ctx.logger.debug('claim released before any native slice arrived — nothing to emit', {
        tags: { deviceId },
        meta: { cap: capName, owner },
      })
    }
    return { ok: true, changed: true }
  }

  /** The claims on a device; empty for every device without one. */
  ownedCaps(deviceId: number): OwnedCaps {
    return this.claims.ownedCaps(deviceId)
  }

  /** The NATIVE shadow of one cap — for the owner-side mechanism only (D224). */
  nativeSlice(deviceId: number, cap: string): Record<string, unknown> | null {
    const raw = this.stateMirror.get(deviceId)?.get(cap)
    return raw ? { ...raw } : null
  }

  /** What the merge says for a claimed cap; null when the cap is not claimed. */
  effectiveIfClaimed(deviceId: number, cap: string): MergedSlice | null {
    return this.claims.effective(deviceId, cap)
  }

  isSeeded(deviceId: number): boolean {
    return this.seeded.has(deviceId)
  }

  /**
   * Forget a removed device (D677): its armed row write is cancelled and one
   * in flight awaited BEFORE its memory goes, so nothing writes its row back
   * after `removeDevice` clears it.
   */
  async forgetDevice(deviceId: number): Promise<void> {
    // A row read in flight would seed memory back after the purge.
    await this.seeding.get(deviceId)?.catch(() => undefined)
    await this.writer.forget(deviceId)
    this.stateMirror.delete(deviceId)
    this.claims.clearDevice(deviceId)
    this.seeded.delete(deviceId)
    this.rowRead.delete(deviceId)
    this.seedRefusalLogged.delete(deviceId)
  }

  /** The device's row was read in this process — the precondition of every row write (D677). */
  isRowRead(deviceId: number): boolean {
    return this.rowRead.has(deviceId)
  }

  /**
   * The SYNCHRONOUS half of {@link ensureSeeded}, branch (c): a LOADED claims
   * index that does not name the device vouches for its CLAIMS — seeded, no
   * read. That is all it vouches for: the device is still not `rowRead`, and
   * the writer reads the row before its first write (D677).
   * Refused (false) while a read is in flight, because that read may be
   * landing a claim the index does not know yet; refused when the index cannot
   * vouch. The overlay's `peek` calls this instead of `ensureSeeded`: a sync
   * path must never hold a promise that can reject (D391 — an unhandled
   * rejection is an untagged line on hub-main).
   */
  seedIfIndexClears(deviceId: number, index: ClaimsIndexView): boolean {
    if (this.seeded.has(deviceId)) return true
    if (this.seeding.has(deviceId)) return false
    if (index.state !== 'loaded' || index.hasClaims(deviceId)) return false
    this.seeded.add(deviceId)
    return true
  }

  /**
   * Make sure the device's CLAIMS are known before a status read is answered
   * or a native slice applied (D49). Index first, single-flight (ruling S6):
   *   (a) already seeded → nothing;
   *   (b) a seed in flight → await it;
   *   (c) a LOADED index that does not name the device → seeded, no read;
   *   (d) otherwise read the row once and seed it.
   * A read that throws propagates and is logged once per device transition
   * (D391).
   *
   * Also the native-write RPC's gate: a slice may be APPLIED once its claims
   * are known. Never the ROW write's: branch (c) knows the claims and nothing
   * about the native slices on the row; a writer that trusted it replaced a
   * row it never read with the one slice it held, and every restored cap
   * nobody re-wrote soon after boot was erased (D677, superseding S6(c) for
   * writes). The writer calls {@link ensureRowRead}.
   */
  async ensureSeeded(
    deviceId: number,
    settings: DeviceManagerSettings,
    index: ClaimsIndexView,
  ): Promise<void> {
    if (this.seeded.has(deviceId)) return
    const inFlight = this.seeding.get(deviceId)
    if (inFlight) return inFlight
    if (this.seedIfIndexClears(deviceId, index)) return
    return this.readRowOnce(deviceId, settings)
  }

  /**
   * A row write replaces the whole row: memory must hold what the row held
   * (D677). Reads the row once, single-flight, and fills memory's gaps from it
   * (`seedMirror('fill')`: a slice memory already holds is newer and wins).
   * A read that throws propagates — nothing is written — and is logged once
   * per device transition (D49, D391).
   */
  async ensureRowRead(deviceId: number, settings: DeviceManagerSettings): Promise<void> {
    if (this.rowRead.has(deviceId)) return
    const inFlight = this.seeding.get(deviceId)
    if (inFlight) return inFlight
    return this.readRowOnce(deviceId, settings)
  }

  /** An unreadable row is a NAMED refusal (D49): the answer is unknown — a
   *  throw could be read as "gone", `not-claimed` as "never was". Logged by `readRowOnce`. */
  private async readRowOrRefuse(
    deviceId: number,
    settings: DeviceManagerSettings,
  ): Promise<ClaimOutcome | null> {
    try {
      await this.ensureRowRead(deviceId, settings)
      return null
    } catch (err: unknown) {
      return refused('row-unreadable', `device ${deviceId}: ${errorMessage(err)}`)
    }
  }

  private readRowOnce(deviceId: number, settings: DeviceManagerSettings): Promise<void> {
    const read = (async () => {
      try {
        const row = await settings.readDeviceRuntimeState(deviceId)
        this.seedMirror(deviceId, this.withResetSessionProbe(row))
        this.seedRefusalLogged.delete(deviceId)
      } catch (err: unknown) {
        if (!this.seedRefusalLogged.has(deviceId)) {
          this.seedRefusalLogged.add(deviceId)
          this.ctx.logger.warn(SEED_REFUSAL_MESSAGE, {
            tags: { deviceId },
            meta: { error: errorMessage(err) },
          })
        }
        throw err
      } finally {
        this.seeding.delete(deviceId)
      }
    })()
    this.seeding.set(deviceId, read)
    return read
  }

  private nativeOf(deviceId: number, capName: string): Record<string, unknown> | null {
    return this.stateMirror.get(deviceId)?.get(capName) ?? null
  }

  /**
   * Write the row now — a claim is atomic with the row — and refresh the
   * baseline. Queued behind any write in flight for the device (one row write
   * at a time, N-4), and the blob is taken when the write RUNS, so it carries
   * whatever memory holds by then. A failed write is rolled back in memory IF
   * what this op put there is still there (the two never disagree); when a
   * newer same-owner state landed in the window it stands, and the debounced
   * writer converges the row to it. Either way the failure is logged hub-side
   * (D391) and rethrown; a repeat of the same claim is then a real write, never
   * `changed: false`, and consumers are handed the truth that stands.
   */
  private async writeThrough(
    deviceId: number,
    settings: DeviceManagerSettings,
    op: WriteThroughOp,
    rollback: ConditionalRollback,
  ): Promise<void> {
    try {
      // Through the writer: queued, row read first, drops reported (D677).
      await this.writer.writeThroughRow(deviceId, settings, op.op)
    } catch (err: unknown) {
      const extras = {
        tags: { deviceId },
        meta: { cap: op.cap, owner: op.owner, error: errorMessage(err) },
      }
      if (rollback()) {
        this.ctx.logger.warn(
          `${op.op} write-through failed — ${op.op} not recorded, memory rolled back`,
          extras,
        )
        this.reemitAfterRollback(deviceId, op.cap)
      } else {
        this.ctx.logger.warn(
          `${op.op} write-through failed — a newer state of the claim stands, memory kept; ` +
            'the row converges through the writer',
          extras,
        )
        this.writer.armOrHold(deviceId, settings)
      }
      throw err
    }
  }

  /** After a rollback, re-emit what is true now: the restored claim's merge, or the native. */
  private reemitAfterRollback(deviceId: number, capName: string): void {
    const claim = this.claims.claim(deviceId, capName)
    const native = this.nativeOf(deviceId, capName)
    if (claim) {
      this.claims.recompute(deviceId, capName, claim, native, /* emitUnchanged */ true)
      return
    }
    if (native) this.emitStateChanged(deviceId, capName, { ...native })
  }

  // ── Disk writes ────────────────────────────────────────────────────────────

  /** Arm the debounced writer for a change to `changedCap` — see `MirrorRowWriter.schedule`. */
  scheduleRuntimeStateDiskWrite(
    deviceId: number,
    settings: DeviceManagerSettings,
    changedCap: string,
  ): void {
    this.writer.schedule(deviceId, settings, changedCap)
  }

  /** Hold the writer off these rows for a migration — see `MirrorRowWriter.holdDiskWrites`. */
  holdDiskWrites(
    deviceIds: readonly number[],
    settings: DeviceManagerSettings,
  ): Promise<MirrorWriteHold> {
    return this.writer.holdDiskWrites(deviceIds, settings)
  }

  /** Flush every pending debounced disk write (graceful shutdown). */
  flushPendingWrites(settings: DeviceManagerSettings | undefined): Promise<void> {
    return this.writer.flushPendingWrites(settings)
  }

  /** The device's row as it may reach disk: NATIVE slices plus `$owned`, restricted by durability. */
  private persistableForDevice(deviceId: number): Record<string, Record<string, unknown>> {
    return persistableBlob(
      joinRuntimeBlob(
        this.nativeSnapshotForDevice(deviceId),
        this.claims.ownedCaps(deviceId),
        this.policyFor,
      ),
      this.policyFor,
    )
  }

  // ── Seeding ────────────────────────────────────────────────────────────────

  /**
   * One-shot mirror seed used by `loadRuntimeState` at boot so the hub knows
   * every persisted slice before the first `setCapSlice`. No events emitted —
   * population, not a transition. `fill` (default) fills GAPS and never
   * overwrites memory (ruling S6: a slice in memory is at least as new as the
   * row, a claim in memory was written through); `replace` (the migration
   * reseed) drops the device's memory first — the row now belongs to different
   * hardware. Malformed `$owned` entries are dropped by name and logged once.
   * Callers pass the blob through `withResetSessionProbe` first.
   */
  seedMirror(deviceId: number, blob: Record<string, unknown>, mode: SeedMode = 'fill'): void {
    const split = splitRuntimeBlob(blob)
    if (mode === 'replace') {
      this.stateMirror.delete(deviceId)
      this.claims.clearDevice(deviceId)
    }
    let perCap = this.stateMirror.get(deviceId)
    if (!perCap) {
      perCap = new Map()
      this.stateMirror.set(deviceId, perCap)
    }
    for (const [capName, raw] of Object.entries(split.native)) {
      if (!perCap.has(capName)) perCap.set(capName, { ...raw })
    }
    this.claims.seedClaims(deviceId, split.owned)
    if (split.dropped.length > 0) {
      this.ctx.logger.warn('malformed $owned entries on the runtime-state row dropped by name', {
        tags: { deviceId },
        meta: { caps: split.dropped },
      })
    }
    // Every claim now in memory gets its view; a seed is population, so
    // nothing is emitted — the view is what reads answer from.
    for (const [capName, cap] of this.claims.claimsOf(deviceId)) {
      this.claims.seedView(deviceId, capName, cap, this.nativeOf(deviceId, capName))
    }
    this.seedRunningFlip(deviceId)
    this.seeded.add(deviceId)
    this.rowRead.add(deviceId)
    // What we just READ is what disk holds, so it is the effective-change
    // baseline — the ROW, never memory. Without one the first write after boot
    // always costs a commit; from memory, a write still in its debounce window
    // would look persisted and be skipped, losing a durable toggle or counter
    // at the next restart. (`withResetSessionProbe` blanks `feature-probe` for
    // the MIRROR only; it is session-only and never in this projection.)
    this.writer.markPersisted(
      deviceId,
      persistableBlob(joinRuntimeBlob(split.native, split.owned, this.policyFor), this.policyFor),
    )
  }

  /**
   * The hub mirror's `feature-probe.lastProbedAt` is a PER-SESSION liveness
   * signal — it means "this worker process completed a probe THIS session".
   * Persisted runtime state carries the PRE-RESTART timestamp, which is stale
   * after a hub or worker restart: the device has not re-probed yet. Seeding it
   * verbatim makes `resolveDeviceProbed` report `probed:true` during the
   * restart→reprobe window, which defeats the export carry-forward gate
   * (`resolveExportFingerprint`, gated on `device.probed`) and posts a spurious
   * partial `AddOrUpdateReport` to Alexa/HAP before the real probe lands.
   *
   * Reset `lastProbedAt` to 0 for the MIRROR seed only — `probed:false` carries
   * the last-advertised fingerprint forward until the worker republishes a
   * fresh probe (its post-probe `setCapSlice` raises `lastProbedAt` again, which
   * also fires `DeviceReady`). The worker's returned `initialRuntimeState` blob
   * is untouched, and every non-probe slice (e.g. `device-status`/online) is
   * preserved.
   */
  withResetSessionProbe(blob: Record<string, unknown>): Record<string, unknown> {
    const probe = blob['feature-probe']
    if (!probe || typeof probe !== 'object' || Array.isArray(probe)) return blob
    return {
      ...blob,
      'feature-probe': { ...(probe as Record<string, unknown>), lastProbedAt: 0 },
    }
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  /**
   * Resolve a device's REAL `online` flag for the persisted/forked-worker
   * list branch. Forked workers own the live `IDevice` in their own process,
   * so the hub registry can't read `device.online` directly. The owning
   * driver instead publishes its liveness through the auto-registered
   * `device-status` runtime-state slice (`markOnline` → `setCapState`), which
   * the canonical `deviceState.setCapSlice` write entrypoint mirrors into the
   * hub-side `stateMirror`. We read that mirrored slice here so the list
   * payload reflects the device's actual reachability instead of a constant.
   *
   * Fallback (`fallbackOnline`) preserves the legacy behaviour when no slice
   * has been published yet: a persisted device with a live registry is
   * assumed online (it was successfully registered by its owning process),
   * and the null-registry "offline view" keeps reporting offline. We never
   * regress a device to offline merely because its mirror is empty.
   */
  resolveDeviceOnline(deviceId: number, fallbackOnline: boolean): boolean {
    const raw = this.stateMirror.get(deviceId)?.get(deviceStatusCapability.name)
    if (!raw) return fallbackOnline
    const parsed = DeviceStatusSchema.safeParse(raw)
    if (!parsed.success) return fallbackOnline
    const status: DeviceStatus = parsed.data
    return status.online
  }

  /**
   * Derive the `probed` flag for an offline-view (forked-worker, not
   * live in the hub registry) device projection. Reads the mirrored
   * `feature-probe` slice the owning worker publishes. Mirrors the
   * `toDeviceInfo` rule: no mirrored slice → ready (`true`, no probe seen);
   * slice present → ready iff `lastProbedAt` has advanced past 0. The
   * mirror is populated when the worker's first `setCapSlice` RPC arrives
   * (BaseDevice seeds `feature-probe` `lastProbedAt:0` at construction, but
   * cross-process delivery is async); until then the no-entry path returns
   * `true` — a brief transient window, same as `resolveDeviceOnline`.
   */
  resolveDeviceProbed(deviceId: number): boolean {
    const raw = this.stateMirror.get(deviceId)?.get('feature-probe')
    if (!raw) return true
    const lastProbedAt = typeof raw.lastProbedAt === 'number' ? raw.lastProbedAt : 0
    return lastProbedAt > 0
  }

  /** The EFFECTIVE slices of a device: native for an unclaimed cap, the merge
   *  for a claimed one (a held cap is not reported). */
  snapshotForDevice(deviceId: number): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {}
    for (const [k, v] of this.stateMirror.get(deviceId) ?? []) {
      if (this.claims.isClaimed(deviceId, k)) continue
      out[k] = { ...v }
    }
    for (const [k, v] of this.claims.visibleCaps(deviceId)) out[k] = { ...v }
    return out
  }

  /** One cap's EFFECTIVE slice, cloned. Null when the device has never written
   *  it — callers read that as "the cap has no state", never as an empty slice —
   *  and null while a claim holds it. */
  capSlice(deviceId: number, cap: string): Record<string, unknown> | null {
    const visible = this.claims.visible(deviceId, cap)
    if (visible !== undefined) return visible ? { ...visible } : null
    const raw = this.stateMirror.get(deviceId)?.get(cap)
    return raw ? { ...raw } : null
  }

  /** The device's NATIVE slices — what the row stores under the cap names. */
  private nativeSnapshotForDevice(deviceId: number): Record<string, Record<string, unknown>> {
    const perCap = this.stateMirror.get(deviceId)
    if (!perCap) return {}
    const out: Record<string, Record<string, unknown>> = {}
    for (const [k, v] of perCap) out[k] = { ...v }
    return out
  }

  /** Whole-system mirror dump. Backs `deviceState.getAllSnapshots` — one
   *  round-trip for a warm boot instead of N per-device calls. */
  allSnapshots(): Record<string, Record<string, Record<string, unknown>>> {
    const out: Record<string, Record<string, Record<string, unknown>>> = {}
    const deviceIds = new Set([...this.stateMirror.keys(), ...this.claims.deviceIds()])
    for (const deviceId of deviceIds) {
      out[String(deviceId)] = this.snapshotForDevice(deviceId)
    }
    return out
  }

  /** Remember a restored running bit so the first public merge does not emit a flip. */
  private seedRunningFlip(deviceId: number): void {
    const slice = this.capSlice(deviceId, RUNNING_STATE_CAP)
    if (slice === null) return
    const running = slice['running']
    this.runningFlip.seed(deviceId, running === true || running === false ? running : null)
  }

  /**
   * The PUBLIC event: exactly `{ deviceId, capName, slice }` for every device,
   * claimed or not. The native shadow never rides here (D224) — see
   * `emitNativeShadow`.
   */
  private emitStateChanged(
    deviceId: number,
    capName: string,
    slice: Record<string, unknown>,
  ): void {
    if (capName === RUNNING_STATE_CAP) {
      const flip = this.runningFlip.note(deviceId, slice)
      if (flip !== null) {
        this.ctx.eventBus.emit({
          id: randomUUID(),
          timestamp: new Date(),
          source: { type: 'device', id: deviceId },
          category:
            flip.kind === 'started' ? EventCategory.RunningStarted : EventCategory.RunningFinished,
          data: { deviceId: flip.deviceId, since: flip.since, phase: flip.phase },
        })
      }
    }
    this.ctx.eventBus.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source: { type: 'device', id: deviceId },
      category: EventCategory.DeviceStateChanged,
      data: { deviceId, capName, slice },
    })
  }

  /**
   * The owner-only event (D224, D663): the native slice as the provider wrote
   * it, for the composer's native self-reads. Its category is refused by the
   * public event routers (`isOwnerOnlyEventCategory`), so no UI or share-scope
   * subscriber ever sees a second truth beside the merged slice.
   */
  private emitNativeShadow(
    deviceId: number,
    capName: string,
    native: Record<string, unknown>,
  ): void {
    this.ctx.eventBus.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source: { type: 'device', id: deviceId },
      category: EventCategory.DeviceNativeShadowChanged,
      data: { deviceId, capName, native },
    })
  }
}
