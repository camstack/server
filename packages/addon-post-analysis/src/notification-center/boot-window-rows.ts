/**
 * The BOOT WINDOW of a durable ledger (D698): what a ledger observed before its
 * boot `load` ANSWERED, held so the load can merge it instead of racing it.
 *
 * ## The bug this pins
 *
 * The notification centre receives bus events from the moment it starts, and
 * its boot back-fill reads the ledgers one after the other — the liveness
 * ledger after the device directory, the system-state ledger later still. In
 * that window a mirror is EMPTY, so an event re-announced at boot (every
 * provider re-announces its devices) used to be written as a brand-new row
 * stamped "now", persisted write-behind, and then:
 *
 *  - the load REPLACED the mirror with what the store held — the stored row
 *    where the seed's write had not landed yet, the seed where it had;
 *  - the store held the seed either way, so the NEXT load (the next runner
 *    respawn) read "now" for every one of them.
 *
 * Measured on the hub, 2026-10-01: five sensors offline since 10:36 read
 * "offline since 19:43" — the restart — one of them at once, all five an hour
 * later. A restart had RESET a fact it learned nothing new about.
 *
 * ## The rule
 *
 * Before the load has answered, an observation that would CREATE a row is
 * PROVISIONAL: it is staged in the mirror (the verdicts read it as they always
 * did) and never persisted. When the load answers, each provisional row is
 * judged against the stored one by the owner's `merge`:
 *
 *  - the stored row already says the same thing → the stored row stays, with
 *    its own timestamp (unknown is not "now", D49/D393);
 *  - it says something else, or nothing → the provisional row is written, with
 *    the time it was observed.
 *
 * A row the ledger WROTE inside the window (a real flip, observed twice in this
 * process) is newer than anything the store holds, so the load must not regress
 * the mirror to the store's older copy; a row it REMOVED inside the window is
 * removed again. A load that FAILS changes nothing here: the window stays
 * open, nothing provisional is ever written over a store nobody could read.
 *
 * A CLOSE heard in the window about a row only the STORE holds (a stream that
 * came back at boot, a `server-updated` that ends an update row) cannot be
 * applied to a mirror that does not hold the row yet. The owner DEFERS it
 * ({@link BootWindowRows.deferWhileOpen}) and the settle replays it against the
 * loaded rows — BEFORE the provisional rows are merged, so a state that closed
 * and then opened again inside the window is held as the new opening (D698
 * review H1).
 *
 * The window is closed by `settle()`, not by the load answering: an
 * observation handled between the two still belongs to the window (review L1).
 */
import type { IScopedLogger } from '@camstack/types'
import type { DurableLedger } from '../durable/durable-ledger.js'

type BootWindowEntry<TRow> =
  | { readonly kind: 'provisional'; readonly row: TRow }
  | { readonly kind: 'written'; readonly row: TRow }
  | { readonly kind: 'removed' }

/** What the settle did — the owner logs it (D391: nothing it decides is silent). */
export interface BootWindowMerge {
  /** Provisional rows the store already held the same fact for — the stored row stayed. */
  readonly keptStored: number
  /** Provisional rows written because the store held another fact, or none. */
  readonly written: number
  /** ROWS closed at the settle by closes heard in the window (not the closes deferred). */
  readonly replayed: number
}

export interface BootWindowRowsDeps<TRow> {
  readonly ledger: DurableLedger<TRow>
  readonly keyOf: (row: TRow) => string
  /** The device a row is about, for the `deviceId` tag of its log line. */
  readonly deviceIdOf: (row: TRow) => number | undefined
  /**
   * The owner's judgement: the row to hold after the load, given the stored
   * row (if any) and the provisional one. Returning `stored` itself keeps it
   * and writes nothing.
   */
  readonly merge: (stored: TRow | undefined, provisional: TRow) => TRow
  readonly logger: IScopedLogger
}

export class BootWindowRows<TRow> {
  private readonly window = new Map<string, BootWindowEntry<TRow>>()
  /** Deferred closes, keyed so a repeat (one per detection) replaces rather than grows. */
  private readonly deferred = new Map<string, () => number>()
  private settled = false

  constructor(private readonly deps: BootWindowRowsDeps<TRow>) {}

  /** Is the ledger still inside its boot window (not settled after an answered load)? */
  open(): boolean {
    return !this.settled
  }

  /** Stage a row that would be CREATED inside the window — mirror only, never persisted. */
  stageProvisional(row: TRow): void {
    this.deps.ledger.stage(row)
    this.window.set(this.deps.keyOf(row), { kind: 'provisional', row })
  }

  /** A row the ledger persisted inside the window: the load must not regress it. */
  noteWritten(row: TRow): void {
    this.window.set(this.deps.keyOf(row), { kind: 'written', row })
  }

  /** A key the ledger removed inside the window: the load must not resurrect it. */
  noteRemoved(key: string): void {
    this.window.set(key, { kind: 'removed' })
  }

  /**
   * While the window is open, keep `replay` to run against the LOADED rows at
   * the settle; once settled, nothing — the caller's own pass already saw every
   * row (review LOW-5: no allocation per detection after boot). `key` names the
   * close: the same key deferred twice runs once, at the place it was first
   * deferred. `replay` answers how many rows it closed.
   */
  deferWhileOpen(key: string, replay: () => number): void {
    if (this.open()) this.deferred.set(key, replay)
  }

  /**
   * Close the window — call right after the ledger's `load`. A load that did
   * not answer leaves the window open and returns `null`.
   */
  settle(): BootWindowMerge | null {
    if (this.settled) return null
    if (!this.deps.ledger.hasAnswered()) {
      // Said, because nothing retries the load: these closes and provisional
      // rows wait for a load this process may never make (review LOW-3).
      this.deps.logger.warn('boot window NOT settled — the load did not answer', {
        meta: {
          collection: this.deps.ledger.collection,
          pendingCloses: this.deferred.size,
          provisionalRows: this.window.size,
        },
      })
      return null
    }
    this.settled = true
    const ledger = this.deps.ledger
    // Closes first, against the stored rows only: what opened AFTER them in the
    // window is merged below and must survive them.
    let replayed = 0
    for (const replay of this.deferred.values()) replayed += replay()
    this.deferred.clear()
    let keptStored = 0
    let written = 0
    for (const [key, entry] of this.window) {
      if (entry.kind === 'removed') {
        void ledger.forget(key)
        continue
      }
      if (entry.kind === 'written') {
        ledger.stage(entry.row)
        continue
      }
      // A row staged in the gap between the load answering and this settle is
      // the provisional row itself, not something the store held.
      const mirrored = ledger.get(key)
      const stored = mirrored === entry.row ? undefined : mirrored
      const held = this.deps.merge(stored, entry.row)
      const deviceId = this.deps.deviceIdOf(entry.row)
      const tags = deviceId !== undefined ? { tags: { deviceId } } : {}
      if (stored !== undefined && held === stored) {
        keptStored += 1
        this.deps.logger.debug('boot-window row kept as stored — the restart learned nothing new', {
          ...tags,
          meta: { collection: ledger.collection, key },
        })
        continue
      }
      void ledger.put(held)
      written += 1
      this.deps.logger.debug('boot-window row written at load', {
        ...tags,
        meta: { collection: ledger.collection, key, stored: stored !== undefined },
      })
    }
    this.window.clear()
    const merge = { keptStored, written, replayed }
    this.deps.logger.info('boot window settled', {
      meta: { collection: ledger.collection, ...merge },
    })
    return merge
  }
}
