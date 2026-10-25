/**
 * The ROW WRITER of the hub runtime-state mirror (`DeviceStateMirror`): every
 * write of a device's `__device-state:<id>` row goes through here — the
 * debounced writer, a claim's write-through, the migration drain, the shutdown
 * flush.
 *
 * Every row write of a device goes through ONE queue per device
 * (`serialiseWrite`), so two writes are never in flight at once and each
 * carries the memory of the moment it RUNS (`persistableFor`, supplied by the
 * mirror). What is believed to be on disk (`lastPersisted`) is the baseline of
 * the effective-change gate. A migration HOLDS the writer off two rows while it
 * swaps them (`holdDiskWrites`).
 *
 * Extracted from `device-state-mirror.ts` (D663 final review I-2) — the mirror
 * owns memory and the merge; this owns what reaches the row, and when.
 *
 * ── Never write a row this process has not READ (D677) ────────────────────
 * A row write REPLACES the whole row. So every write path — debounced,
 * write-through, drain, shutdown flush — first makes sure the device's row was
 * read into memory (`readRowFirst`, the mirror's single-flight `fill` seed:
 * memory wins per cap, the row fills the gaps). A read that fails writes
 * NOTHING and is logged once per episode with `tags.deviceId`. A write that
 * would still drop a cap the stored row holds is logged at warn, by name: the
 * boot race that did exactly that was silent since at least 09-18 (159 shrinks, 15
 * cameras, 65 of 82 hub restarts).
 */
import type { IScopedLogger } from '@camstack/types'
import type { DeviceManagerSettings } from './device-meta-store.js'
import { OWNED_FIELDS_KEY } from './field-ownership.js'
import { MigrationRefusedError } from './migration-refused.js'
import { effectivelyEqual, type RuntimeStatePolicyLookup } from './runtime-state-persist-gate.js'

/** A device's row as it may reach disk: cap name → persistable slice (plus `$owned`). */
export type PersistableRow = Record<string, Record<string, unknown>>

/** Which path wrote (or tried to write) a row — named on every line it logs. */
export type RowWritePath = 'debounced' | 'shutdown-flush' | 'drain' | 'claim' | 'release'

/**
 * A write-through refused because the device's row could not be read first
 * (D677). Nothing was written; the caller rolls its memory change back.
 */
export class RuntimeStateRowUnreadError extends Error {
  constructor(readonly deviceId: number) {
    super(
      `runtime-state row of device ${deviceId} could not be read — nothing written, ` +
        'a row this process has not read is never replaced',
    )
    this.name = 'RuntimeStateRowUnreadError'
  }
}

const ROW_UNREAD_REFUSAL_MESSAGE =
  'runtime-state row write refused — the row could not be read first, nothing written'
const ROW_DROPS_CAPS_MESSAGE = 'runtime-state row write DROPS caps the stored row holds'

/** Per-device state of the row writer: the debounce timer and the write queue. */
interface WriteSlot {
  timer: ReturnType<typeof setTimeout> | null
  /**
   * The tail of this device's row-write QUEUE, or null when idle. Every row
   * write — debounced, write-through, shutdown flush — is chained here, so one
   * write is in flight per device and each computes its blob when it RUNS (the
   * latest memory). It never rejects; a write-through's failure is its caller's.
   */
  inFlight: Promise<void> | null
  /**
   * The last debounced write for this device FAILED and nothing has
   * landed since: the row is not what `lastPersisted` says. A migration
   * drain must not read that as "landed" (D663 5b ruling I-2).
   */
  lastWriteFailed: boolean
  /**
   * Consecutive debounced writes refused because the row could not be read
   * (D677). Drives the re-arm backoff; 0 once a read succeeds.
   */
  unreadRefusals: number
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The drain before a migration could not vouch for a device's row. Nothing has
 * moved yet, so it is a {@link MigrationRefusedError}: the migration refuses
 * and restores both cameras' switches.
 */
export class RuntimeStateDrainError extends MigrationRefusedError {
  constructor(
    readonly deviceId: number,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(
      `migration refused: the runtime state of device ${deviceId} could not be drained ` +
        `before the swap (${reason}) — nothing moved; retry the migration`,
      options,
    )
    this.name = 'RuntimeStateDrainError'
  }
}

/** A migration's hold on the debounced writer (`holdDiskWrites`). */
export interface MirrorWriteHold {
  /** Let the writer back onto the rows; re-arms it so the row converges to memory. */
  readonly release: () => void
}

/** What the writer needs from the mirror that owns it. */
export interface MirrorRowWriterDeps {
  readonly logger: IScopedLogger
  /** Per-cap durability + volatile-field policy (D4). */
  readonly policyFor: RuntimeStatePolicyLookup
  /** The device's row as memory holds it NOW — taken when a write RUNS. */
  readonly persistableFor: (deviceId: number) => PersistableRow
  /** The device's row was read into memory in this process (D677). */
  readonly isRowRead: (deviceId: number) => boolean
  /**
   * Read the row into memory — single-flight, `fill` (memory wins per cap).
   * Rejects when the row cannot be read; memory is then unchanged.
   */
  readonly readRowFirst: (deviceId: number, settings: DeviceManagerSettings) => Promise<void>
}

export class MirrorRowWriter {
  static readonly RUNTIME_STATE_DEBOUNCE_MS = 1000
  /** Ceiling of the re-arm backoff while a device's row cannot be read (D677, D3). */
  static readonly UNREAD_REARM_MAX_MS = 60_000

  /** The re-arm delay after `refusals` consecutive unread refusals: 1 s, 2 s, 4 s … capped at 60 s. */
  static unreadRearmDelayMs(refusals: number): number {
    const exponent = Math.max(0, refusals - 1)
    return Math.min(
      MirrorRowWriter.RUNTIME_STATE_DEBOUNCE_MS * 2 ** exponent,
      MirrorRowWriter.UNREAD_REARM_MAX_MS,
    )
  }

  /**
   * Per-device disk-write debouncer for runtime-state. `setCapSlice`
   * updates the in-memory mirror synchronously and emits the change
   * event immediately, but the disk write is coalesced.
   */
  private readonly runtimeStateDebounce = new Map<number, WriteSlot>()

  /**
   * Devices whose debounced writer is HELD off the row — a migration is
   * swapping it (`holdDiskWrites`). A change while held stays in memory only.
   */
  private readonly writesHeld = new Set<number>()
  /** Held devices a durable change was scheduled for — what `release` re-arms. */
  private readonly heldDirty = new Set<number>()

  /**
   * What is believed to be ON DISK for each device — the persistable projection
   * of the last blob actually written (or read at seed time). The
   * effective-change gate compares against THIS, not against the previous
   * mirror state: two clock-only ticks in a row must not add up to a write just
   * because each was compared with its immediate predecessor.
   */
  private readonly lastPersisted = new Map<number, PersistableRow>()

  /**
   * Per-device count of writes the effective-change gate skipped since the last
   * real one. Reported on the next write that DOES happen, so the log says how
   * much churn the gate absorbed instead of saying nothing at all — a branch
   * that drops work silently reads as "never happened".
   */
  private readonly skippedSinceWrite = new Map<number, number>()

  /** Devices whose unreadable-row refusal is already logged — once per episode. */
  private readonly rowUnreadLogged = new Set<number>()

  constructor(private readonly deps: MirrorRowWriterDeps) {}

  /** What is believed to be on the device's row; undefined before any read or write. */
  persisted(deviceId: number): PersistableRow | undefined {
    return this.lastPersisted.get(deviceId)
  }

  /** Record what the row now holds — a write that landed, or a row just read. */
  markPersisted(deviceId: number, row: PersistableRow): void {
    this.lastPersisted.set(deviceId, row)
  }

  /** A migration holds the writer off this device's row right now. */
  isHeld(deviceId: number): boolean {
    return this.writesHeld.has(deviceId)
  }

  /**
   * Chain a row write behind whatever is in flight for the device. Returns the
   * write's own promise (it may reject, to its caller); the queue tail never
   * rejects and clears itself once it is the last one out.
   */
  serialiseWrite<T>(deviceId: number, task: () => Promise<T>): Promise<T> {
    const slot = this.slotFor(deviceId)
    const prior = slot.inFlight ?? Promise.resolve()
    const run = prior.then(task)
    const tail: Promise<void> = run.then(
      () => undefined,
      () => undefined,
    )
    slot.inFlight = tail
    void tail.then(() => {
      if (slot.inFlight === tail) slot.inFlight = null
    })
    return run
  }

  private slotFor(deviceId: number): WriteSlot {
    let slot = this.runtimeStateDebounce.get(deviceId)
    if (!slot) {
      slot = { timer: null, inFlight: null, lastWriteFailed: false, unreadRefusals: 0 }
      this.runtimeStateDebounce.set(deviceId, slot)
    }
    return slot
  }

  /** Arm the writer for a durable change, or remember it for `release` while a migration holds the device. */
  armOrHold(deviceId: number, settings: DeviceManagerSettings): void {
    if (this.writesHeld.has(deviceId)) {
      this.heldDirty.add(deviceId)
      return
    }
    this.armDiskWrite(deviceId, settings)
  }

  /**
   * Debounced disk writer, behind two gates.
   *
   * GATE — DURABILITY: a change to a `durability: 'session'` cap never even
   * arms the timer. That is where the fleet's write rate goes: `audio-metrics`
   * and `zone-analytics` are ~90 % of the offered 12–19 writes/s, they change
   * genuinely every second, and their restored value is worthless.
   *
   * GATE — EFFECTIVE CHANGE (at flush): the persistable blob is compared with
   * what is believed to be on disk, ignoring the clock fields each cap declared
   * volatile. `battery` wrote its blob 526 times in 25 minutes without one
   * percentage moving; this is the gate that turns those into one write.
   *
   * The blob is read from the live mirror at flush time, so the disk picture is
   * always the latest state — no risk of writing a stale snapshot.
   */
  schedule(deviceId: number, settings: DeviceManagerSettings, changedCap: string): void {
    if (this.deps.policyFor(changedCap).durability !== 'restored') return
    this.armOrHold(deviceId, settings)
  }

  /** Arm the debounce timer; at fire, queue a write of the live blob unless disk already has it. */
  private armDiskWrite(
    deviceId: number,
    settings: DeviceManagerSettings,
    delayMs: number = MirrorRowWriter.RUNTIME_STATE_DEBOUNCE_MS,
  ): void {
    const slot = this.slotFor(deviceId)
    if (slot.timer) return
    slot.timer = setTimeout(() => {
      slot.timer = null
      void this.serialiseWrite(deviceId, () =>
        this.writeLiveBlob(deviceId, settings, slot, 'debounced'),
      )
    }, delayMs)
  }

  /**
   * Forget a removed device: cancel its armed write, await one in flight, and
   * drop its baseline and counters — nothing writes its row after this.
   */
  async forget(deviceId: number): Promise<void> {
    const slot = this.runtimeStateDebounce.get(deviceId)
    if (slot?.timer) {
      clearTimeout(slot.timer)
      slot.timer = null
    }
    if (slot?.inFlight) await slot.inFlight
    this.runtimeStateDebounce.delete(deviceId)
    this.lastPersisted.delete(deviceId)
    this.skippedSinceWrite.delete(deviceId)
    this.rowUnreadLogged.delete(deviceId)
    this.heldDirty.delete(deviceId)
  }

  /**
   * The row is in memory, or is read now (D677). False when the read failed:
   * the caller writes nothing. Logged once per episode, tagged; the episode
   * ends at the next successful read.
   */
  private async rowReadOrRefuse(
    deviceId: number,
    settings: DeviceManagerSettings,
    path: RowWritePath,
  ): Promise<boolean> {
    if (!this.deps.isRowRead(deviceId)) {
      try {
        await this.deps.readRowFirst(deviceId, settings)
      } catch (err: unknown) {
        if (!this.rowUnreadLogged.has(deviceId)) {
          this.rowUnreadLogged.add(deviceId)
          this.deps.logger.warn(ROW_UNREAD_REFUSAL_MESSAGE, {
            tags: { deviceId },
            meta: { path, error: errorMessage(err) },
          })
        }
        return false
      }
    }
    this.rowUnreadLogged.delete(deviceId)
    return true
  }

  /**
   * The ONE call of `writeDeviceRuntimeState`. A blob that lacks a cap the
   * stored row holds is written (memory is the authority once the row was
   * read) but never silently: the dropped caps are named at warn (D677).
   * `$owned` is excluded — a release that empties it is the claim path's own
   * logged business.
   */
  private async writeRow(
    deviceId: number,
    settings: DeviceManagerSettings,
    blob: PersistableRow,
    path: RowWritePath,
  ): Promise<void> {
    const onDisk = this.lastPersisted.get(deviceId)
    if (onDisk) {
      const dropped = Object.keys(onDisk).filter(
        (cap) => cap !== OWNED_FIELDS_KEY && !Object.hasOwn(blob, cap),
      )
      if (dropped.length > 0) {
        this.deps.logger.warn(ROW_DROPS_CAPS_MESSAGE, {
          tags: { deviceId },
          meta: {
            path,
            dropped,
            storedCaps: Object.keys(onDisk).length,
            writtenCaps: Object.keys(blob).length,
          },
        })
      }
    }
    await settings.writeDeviceRuntimeState(deviceId, blob)
    this.lastPersisted.set(deviceId, blob)
  }

  /**
   * A claim's write-through (D663): queued behind the device's writes, the row
   * read first, the blob taken when it runs. Rejects with
   * {@link RuntimeStateRowUnreadError} when the row cannot be read, or with the
   * write's own error; resolves to what landed.
   */
  writeThroughRow(
    deviceId: number,
    settings: DeviceManagerSettings,
    path: RowWritePath,
  ): Promise<PersistableRow> {
    return this.serialiseWrite(deviceId, async () => {
      if (!(await this.rowReadOrRefuse(deviceId, settings, path))) {
        throw new RuntimeStateRowUnreadError(deviceId)
      }
      const live = this.deps.persistableFor(deviceId)
      await this.writeRow(deviceId, settings, live, path)
      return live
    })
  }

  /**
   * The debounced write itself: the row read first (D677), then the blob as
   * memory holds it NOW, behind the effective-change gate. Never rejects. An
   * unreadable row writes nothing; the debounced path re-arms with a backoff
   * (1 s doubling to 60 s — never a 1 Hz loop, D3), and the armed timer is
   * what a migration drain sees as owed, so a row that has become readable
   * drains normally. The shutdown flush does not re-arm.
   */
  private async writeLiveBlob(
    deviceId: number,
    settings: DeviceManagerSettings,
    slot: WriteSlot,
    path: 'debounced' | 'shutdown-flush',
  ): Promise<void> {
    if (!(await this.rowReadOrRefuse(deviceId, settings, path))) {
      if (path === 'debounced') {
        slot.unreadRefusals += 1
        this.rearmAfterUnread(deviceId, settings, slot)
      }
      return
    }
    slot.unreadRefusals = 0
    const blob = this.deps.persistableFor(deviceId)
    if (this.isAlreadyPersisted(deviceId, blob)) return
    const skipped = this.skippedSinceWrite.get(deviceId) ?? 0
    this.skippedSinceWrite.delete(deviceId)
    try {
      await this.writeRow(deviceId, settings, blob, path)
      slot.lastWriteFailed = false
      if (skipped > 0) {
        this.deps.logger.debug('runtime state persisted', {
          tags: { deviceId },
          meta: { caps: Object.keys(blob).length, skippedSinceLastWrite: skipped },
        })
      }
    } catch (err: unknown) {
      // A persist that cannot happen must leave a line naming the device.
      // The collection this writes to read zero on every installation for
      // months and no log line ever said so.
      slot.lastWriteFailed = true
      this.deps.logger.warn('writeDeviceRuntimeState failed', {
        tags: { deviceId },
        meta: { error: errorMessage(err) },
      })
    }
  }

  /** Re-arm an unread refusal with its backoff, or remember it for `release` while held. */
  private rearmAfterUnread(
    deviceId: number,
    settings: DeviceManagerSettings,
    slot: WriteSlot,
  ): void {
    if (this.writesHeld.has(deviceId)) {
      this.heldDirty.add(deviceId)
      return
    }
    this.armDiskWrite(deviceId, settings, MirrorRowWriter.unreadRearmDelayMs(slot.unreadRefusals))
  }

  /**
   * Hold the debounced writer off these devices' rows while a migration swaps
   * them (D663 re-review N-6). Resolves once each device is DRAINED: a write
   * still in its debounce window is written now (it is this hardware's latest
   * state, and the swap then carries it to the right number), and a write
   * already in flight has landed. Until `release`, nothing the writer does
   * reaches these rows — a blob read before the swap and written after it would
   * put the other box's state back under the number, and make it the baseline.
   *
   * Only what the writer already had pending is written — never memory
   * wholesale, which for a row nobody read would overwrite it with a partial
   * picture. `release` re-arms the writer for a device changed while held:
   * after the migration's `replace` reseed memory equals the row and nothing
   * is written; after a failed swap the row converges to memory.
   *
   * The migration must not proceed over a row that is not what memory says it
   * is. So a drain write that FAILS, and equally a write that was in flight and
   * FAILED (ruling I-2 — awaiting it is not the same as it landing), release
   * the hold, log the device and reject with a {@link RuntimeStateDrainError};
   * the owed write is re-armed on release.
   *
   * One hold per device at a time: `writesHeld` is a set, not a refcount, so a
   * second overlapping hold would be released by the first. Safe because the
   * only caller is `migrateDevice`, serialised by `migrationGuard` and the meta
   * write lock; a new caller needs a refcount first.
   */
  async holdDiskWrites(
    deviceIds: readonly number[],
    settings: DeviceManagerSettings,
  ): Promise<MirrorWriteHold> {
    for (const deviceId of deviceIds) this.writesHeld.add(deviceId)
    const release = (): void => {
      for (const deviceId of deviceIds) {
        this.writesHeld.delete(deviceId)
        if (this.heldDirty.delete(deviceId)) this.armDiskWrite(deviceId, settings)
      }
    }
    try {
      for (const deviceId of deviceIds) await this.drainDiskWrite(deviceId, settings)
    } catch (err: unknown) {
      release()
      throw err
    }
    return { release }
  }

  /** Cancel the timer, await the write in flight, then write (queued) what is not yet on disk. */
  private async drainDiskWrite(deviceId: number, settings: DeviceManagerSettings): Promise<void> {
    const slot = this.runtimeStateDebounce.get(deviceId)
    const pending = slot?.timer ?? null
    if (slot && pending) {
      clearTimeout(pending)
      slot.timer = null
    }
    if (slot?.inFlight) await slot.inFlight
    const lastFailed = slot?.lastWriteFailed ?? false
    if (!pending && !lastFailed) return
    if (!(await this.rowReadOrRefuse(deviceId, settings, 'drain'))) {
      this.refuseDrain(deviceId, 'its runtime-state row could not be read first', null)
    }
    const blob = this.deps.persistableFor(deviceId)
    if (this.isAlreadyPersisted(deviceId, blob)) {
      // Memory is back to what the row holds: nothing is owed after all.
      if (slot) slot.lastWriteFailed = false
      return
    }
    if (lastFailed) {
      this.refuseDrain(deviceId, 'its last runtime-state write did not land', null)
    }
    try {
      // Through the queue like every other row write: a write-through that
      // slipped past the migration gate and enqueued during the await above
      // must not run beside this one.
      await this.serialiseWrite(deviceId, () => this.writeRow(deviceId, settings, blob, 'drain'))
    } catch (err: unknown) {
      this.refuseDrain(
        deviceId,
        `the pending runtime-state write failed: ${errorMessage(err)}`,
        err,
      )
    }
  }

  /** A drain that cannot vouch for the row: still owed (re-armed on release), logged, refused. */
  private refuseDrain(deviceId: number, reason: string, cause: unknown): never {
    this.heldDirty.add(deviceId)
    this.deps.logger.warn('migration drain: runtime state not on the row — migration refused', {
      tags: { deviceId },
      meta: { reason },
    })
    throw new RuntimeStateDrainError(deviceId, reason, cause === null ? undefined : { cause })
  }

  /**
   * True when `blob` differs from what is believed to be on disk only in fields
   * the owning caps declared volatile. Counts the skip so the next real write
   * can report how much churn was absorbed.
   */
  private isAlreadyPersisted(deviceId: number, blob: PersistableRow): boolean {
    const onDisk = this.lastPersisted.get(deviceId)
    if (!onDisk) return false
    if (!effectivelyEqual(onDisk, blob, this.deps.policyFor)) return false
    this.skippedSinceWrite.set(deviceId, (this.skippedSinceWrite.get(deviceId) ?? 0) + 1)
    return true
  }

  /** Flush every pending debounced disk write (graceful shutdown). Clears the
   *  debounce slots after awaiting in-flight + scheduled writes so shutdown is
   *  lossless. */
  async flushPendingWrites(settings: DeviceManagerSettings | undefined): Promise<void> {
    const pending: Promise<void>[] = []
    for (const [deviceId, slot] of this.runtimeStateDebounce) {
      if (slot.timer) {
        clearTimeout(slot.timer)
        slot.timer = null
        if (settings) {
          // Queued like every other write, so it lands after whatever is in flight.
          pending.push(
            this.serialiseWrite(deviceId, () =>
              this.writeLiveBlob(deviceId, settings, slot, 'shutdown-flush'),
            ),
          )
          continue
        }
      }
      if (slot.inFlight) pending.push(slot.inFlight)
    }
    await Promise.all(pending)
    this.runtimeStateDebounce.clear()
  }
}
