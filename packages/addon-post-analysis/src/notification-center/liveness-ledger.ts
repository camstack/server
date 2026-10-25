/**
 * NcLivenessLedger — the DURABLE memory of the last liveness the notification
 * centre accepted, per subject.
 *
 * ## Where the mechanics live now
 *
 * This file WAS the mechanism as well as the policy. The 2026-08-13 census
 * found four other stores that had each written the same declare / mirror /
 * reseed / write-behind / choose-a-failure-direction code, so the mechanics
 * were extracted verbatim into {@link DurableLedger} (`../durable/`) and this
 * file kept the part only it can know: WHICH KINDS ARE GOVERNED and WHAT
 * COUNTS AS THE SAME FACT. The verdicts, the durability and the D49 direction
 * below are the primitive's contract, unchanged — `liveness-ledger.spec.ts` is
 * the regression net that says so.
 *
 * ## The bug this pins
 *
 * A liveness notification is a claim about a CHANGE ("the camera went
 * offline"), and a change can only be read from two observations. The centre
 * had exactly one observation and an in-RAM `lastSystemLiveness` map to hold
 * the previous one — so a process that had just started held NONE, and the
 * first `device.online` of every camera read as a fresh transition.
 *
 * Live cost, 2026-08-13: the hub container was recreated. Every provider
 * reconnected and re-announced its devices, and the operator received a
 * "camera online" notification for EVERY camera on the installation (~15+).
 * Nothing had changed; the notification centre had merely forgotten.
 *
 * It is the same shape as the occupancy cold-baseline bug fixed the same week
 * (`occupancy-cold-seed.spec.ts`) and takes the same cure:
 *
 *   **THE FIRST OBSERVATION SEEDS. ONLY A REAL FLIP NOTIFIES.**
 *
 *   - no row for the subject → {@link NcLivenessLedger.observe} answers
 *     `seeded`: the state is written, and NOTHING is notified;
 *   - a row equal to the incoming state → `no-flip`: the duplicate is
 *     discarded (this is also the explicit-category/device-status dedup the
 *     RAM map used to do);
 *   - a row that DIFFERS → `flip`: the notification goes out and the row
 *     advances.
 *
 * ## Durability
 *
 * A records kind (`liveness`) mirrored into RAM — the `OccupancyStore`
 * precedent, and for the same reason the occupancy state is durable: RAM-only
 * memory makes a restart indistinguishable from a change. Every node reaches
 * it through `ctx.records`; {@link NcLivenessLedger.declare} declares the
 * LEGACY table for specs and migration scripts only.
 *
 * ## D49 — the gate is never widened by a fallible read
 *
 * `observe` reads NOTHING but the in-RAM mirror, which is refreshed off the
 * event path (boot {@link NcLivenessLedger.load} only). A failed load leaves
 * the mirror empty, and an empty mirror SEEDS — that is, it fails toward
 * DISCARD. That direction is chosen deliberately: a lost "camera online"
 * costs one line nobody reads, while a phantom flood costs the operator's
 * trust in every notification the hub sends. They have just experienced the
 * second one.
 *
 * The persist is write-behind and best-effort: the mirror advances first so an
 * immediate duplicate is caught even while SQLite is slow, and a failed write
 * costs at most one re-seed on the next boot (a silence, never a flood).
 *
 * ## Which kinds are ledgered — and which deliberately are not
 *
 * {@link ledgeredLiveness} is the ONE decision site.
 *
 *  - `device-*` / `node-*` liveness (plus the legacy `camera-*` tail): YES.
 *    Both are re-announced wholesale on a hub boot — providers reconnect their
 *    devices, and Moleculer fires `$node.connected` for every agent that
 *    re-registers.
 *  - `stream-online` / `stream-offline`: NO. They are already reason-gated at
 *    the intake (`streamHealthAccepted`): a first packet, a lazy-dial suspend,
 *    its resume and a released broker are all refused, so a boot produces no
 *    stream notification to suppress. Their remaining same-edge duplicates are
 *    handled by the centre's RAM dedup, where they cost nothing.
 *  - `device-disabled` / `device-enabled`: NO, and this one matters. The
 *    operator's switch (D62) is emitted only on a TRANSITION of the flag by
 *    `deviceManager.setDisabled` — never at boot. Ledgering it would make the
 *    first disable after a fresh ledger a silent seed: a notification lost for
 *    an action the operator performed by hand, with no flood to justify it.
 *
 * ## Why the row count jumped 263 → 730, and why that is not a leak
 *
 * Measured on the live hub, 2026-08-14. The growth looked alarming for a store
 * whose stated retention is "none, deliberately" and which by design must never
 * prune itself — a store that only ever grows and can never self-clean is worth
 * being suspicious of. It was checked rather than assumed, and it is correct:
 *
 *  - 730 rows = **728 `device:` subjects + 2 `node:` subjects**, exactly the
 *    two families this ledger mints and no third;
 *  - 728 rows, 728 DISTINCT deviceIds — one row per device, no duplicates;
 *  - **zero subjects name a deviceId the installation does not know.** The
 *    installation holds 781 distinct configured deviceIds; every liveness
 *    subject is one of them. The 45 that have no `device-runtime-state` row all
 *    appear in `addon-device-settings`, in contiguous id blocks — accessory and
 *    child devices, not invented ids;
 *  - every row had been rewritten within the preceding ~34 hours.
 *
 * So the jump is the D141 device seeding catching up to the real device
 * population, not subjects accumulating for devices that never existed. 728
 * against 781 is UNDER the installation bound, which is the property the
 * no-prune rule relies on. The rule stands and must not be relaxed.
 *
 * The number to watch is not the row count but the ratio: if subjects ever
 * exceed the configured device count, something is minting ids and the
 * assumption behind "bounded by the installation" has failed.
 */

import type { IScopedLogger, NcSystemEventKind } from '@camstack/types'
import { DurableLedger, type DurableLedgerSpec } from '../durable/durable-ledger.js'
import { type DurableKindDeps } from '../durable/durable-wiring.js'
import { ncDurableRecordKinds } from './nc-durable-record-kinds.js'
import { BootWindowRows } from './boot-window-rows.js'
import type { NcSystemEventSubject } from './rule-engine.js'

/**
 * @durable class=ledger owner=notification-center
 *   write="a liveness state TRANSITION the centre accepted (seed or flip); a no-flip writes nothing"
 *   retention="a deleted device's row is removed by the device-removal hook (D871), driven by the device tombstone; NEVER pruned against the device directory — that is work destroyed on a fallible read (D49/D130). Node rows stay (one per node)."
 */
export const NC_LIVENESS_COLLECTION = 'notification-center:liveness'

const NC_LIVENESS_COLUMNS = [
  /** The subject the intake minted (`device:102`, `node:agent-1`) — one row
   *  each, so the two families can never collide on a key. */
  { name: 'subject', type: 'TEXT' as const, primaryKey: true, notNull: true },
  /** `online` | `offline` — the STATE, not the kind, so a legacy `camera-*`
   *  row and a `device-*` event describing the same fact compare equal. */
  { name: 'state', type: 'TEXT' as const, notNull: true },
  /** The kind that last wrote the row. Telemetry: it makes the table readable
   *  when someone asks "why did 102 not notify". */
  { name: 'kind', type: 'TEXT' as const, notNull: true },
  /** Absent on a node row. Indexed — every question about a device is asked
   *  per-device. */
  { name: 'deviceId', type: 'INTEGER' as const },
  { name: 'updatedAt', type: 'INTEGER' as const, notNull: true },
] as const

const NC_LIVENESS_INDEXES = [
  { name: 'idx_nc_liveness_device', columns: ['deviceId'] as const },
] as const

/** The two states a ledgered subject can be in. */
export type NcLivenessState = 'online' | 'offline'

/**
 * What one observation was worth.
 *
 * `seeded` and `no-flip` both mean "do not notify"; they are two verdicts
 * rather than one because they are two different sentences in the log, and the
 * question "did the hub just forget, or did nothing happen" is exactly the one
 * this ledger exists to answer.
 */
export type NcLivenessVerdict = 'seeded' | 'no-flip' | 'flip'

/** One durable row. */
export interface NcLivenessRow {
  readonly subject: string
  readonly state: NcLivenessState
  readonly kind: string
  readonly deviceId?: number
  readonly updatedAt: number
}

/** A system event reduced to the facts the ledger keys and compares on. */
export interface NcLivenessObservation {
  readonly subject: string
  readonly kind: NcSystemEventKind
  readonly state: NcLivenessState
  readonly deviceId?: number
}

/**
 * The kinds the ledger governs — see the module docblock for why the stream
 * and switch families are absent.
 */
const NC_LEDGERED_KINDS: ReadonlySet<NcSystemEventKind> = new Set<NcSystemEventKind>([
  'device-online',
  'device-offline',
  'node-online',
  'node-offline',
  // The legacy tail. Never produced by the intake today, ledgered anyway so
  // that the day one is (or an old rule path resurfaces) it is governed by the
  // same gate rather than bypassing it.
  'camera-online',
  'camera-offline',
])

/**
 * Reduce a system-event subject to a ledger observation, or `null` when the
 * kind is not one the ledger governs.
 *
 * The ONE place that decides which kinds are gated: a caller that branched on
 * a `kind.startsWith('device-')` prefix would silently pull the operator's
 * disable switch into a liveness ledger, which is the mistake the docblock
 * spells out.
 */
export function ledgeredLiveness(system: NcSystemEventSubject): NcLivenessObservation | null {
  if (!NC_LEDGERED_KINDS.has(system.kind)) return null
  const state: NcLivenessState = system.kind.endsWith('-offline') ? 'offline' : 'online'
  return {
    subject: system.subject,
    kind: system.kind,
    state,
    ...(system.deviceId !== undefined ? { deviceId: system.deviceId } : {}),
  }
}

export interface NcLivenessLedgerDeps extends DurableKindDeps {
  readonly logger: IScopedLogger
}

/**
 * The ledger's mechanics, declared once. Everything policy-shaped is right
 * here in this object: what the KEY is, what the persisted row looks like, and
 * — the only decision the primitive cannot make — WHAT COUNTS AS THE SAME
 * FACT. For liveness the fact is the STATE, so a legacy `camera-online` row
 * and a `device-online` event describing it compare equal, and a repeat never
 * moves `updatedAt`.
 *
 * The reseed is uncapped in practice: the row set is bounded by the
 * installation — one row per device plus one per node — so the primitive's
 * default ceiling still bounds a pathological read. Deliberately NOT pruned
 * against the device directory: a prune is work DESTROYED on a fallible read
 * (D49), and a directory that answered empty once would wipe the ledger and
 * re-arm the very flood this file exists to prevent. A removed device's row is
 * removed by the device-removal hook (D871) from the tombstone, never by a
 * directory scan.
 */
const NC_LIVENESS_SPEC: DurableLedgerSpec<NcLivenessRow> = {
  collection: NC_LIVENESS_COLLECTION,
  columns: NC_LIVENESS_COLUMNS,
  indexes: NC_LIVENESS_INDEXES,
  // A lost write costs at most one silent re-seed on the next boot — a
  // silence, never a flood. The verdict must never wait for SQLite.
  writeMode: 'write-behind',
  keyOf: (row) => row.subject,
  toValue: rowToValue,
  fromRecord: recordToRow,
  equalFact: (held, incoming) => held.state === incoming.state,
  deviceIdOf: (row) => row.deviceId,
}

export class NcLivenessLedger {
  private readonly ledger: DurableLedger<NcLivenessRow>
  /**
   * What was observed before the boot load answered (D698) — see
   * `boot-window-rows.ts`. A stored row holding the same STATE keeps its own
   * `updatedAt`: a restart that re-hears "offline" learned nothing about WHEN
   * the device went offline, and `updatedAt` is the state summary's "since".
   */
  private readonly bootWindow: BootWindowRows<NcLivenessRow>

  constructor(deps: NcLivenessLedgerDeps) {
    this.ledger = new DurableLedger({
      spec: NC_LIVENESS_SPEC,
      kind: deps.records.kind(ncDurableRecordKinds.liveness),
      logger: deps.logger,
    })
    this.bootWindow = new BootWindowRows({
      ledger: this.ledger,
      keyOf: (row) => row.subject,
      deviceIdOf: (row) => row.deviceId,
      logger: deps.logger,
      merge: (stored, provisional) =>
        stored !== undefined && stored.state === provisional.state ? stored : provisional,
    })
  }

  /**
   * Boot reseed — the whole point of the file. Returns the row count so the
   * caller can say out loud how much memory it recovered; "loaded 0" after a
   * container recreate is the one line that would have explained tonight.
   *
   * A failed load KEEPS whatever is already mirrored (the primitive's contract
   * rule 2) rather than clearing it: dropping the memory is what caused the
   * flood, so no error path may do it on purpose.
   */
  async load(): Promise<number> {
    const loaded = (await this.ledger.load()).length
    this.bootWindow.settle()
    return loaded
  }

  /** Drop a deleted device's mirrored rows (the durable ones go by `deleteWhere`, D871). */
  evictDevice(deviceId: number): number {
    return this.ledger.evictDevice(deviceId)
  }

  /** Has a load READ the store once? Until then the mirror is not the truth (D647 reads it). */
  hasAnswered(): boolean {
    return this.ledger.hasAnswered()
  }

  /**
   * Boot seed from the DEVICE DIRECTORY — the second half of the reseed, and
   * the fix for the outage this ledger used to swallow.
   *
   * ## The hole
   *
   * {@link load} recovers what the ledger itself accepted. A device that has
   * never produced a liveness event since the ledger was created has no row at
   * all, so its FIRST observation ever seeds silently — and if that first
   * observation is the camera DYING, the outage is thrown away. Live cost,
   * 2026-08-13 21:36 CEST: the operator unplugged four cameras and received two
   * notifications. `device:103` and `device:112` had never spoken; their
   * unplugging was recorded and never announced. A camera that is quiet until
   * it dies is a camera whose death is silent, indefinitely.
   *
   * ## Why only the ONLINE ones
   *
   * The directory is the device manager's own `online` flag (D132 §3: the
   * authority seeds the mirror at boot and stays the authority). Seeding only
   * the devices it calls ONLINE is what makes this change one-directional:
   *
   *  - a row seeded `online` can only ever turn a later `device.offline` into a
   *    notification — a true sentence about a device that just went away;
   *  - it can NEVER turn a `device.online` into one, and that is the only shape
   *    the 2026-08-13 notification flood (D130) ever had.
   *
   * A device the directory calls offline — which is also what a cold or
   * still-settling directory would say — gets no row and keeps today's
   * behaviour exactly. Failing toward discard, unchanged.
   *
   * ## D49
   *
   * An EXISTING row is never overwritten. The ledger is the authority for what
   * it accepted; the directory is a mirror refreshed on a tick and may be
   * stale. A stale `online` overwriting an accepted `offline` would make the
   * camera's real recovery a no-flip and lose it. A failed directory read
   * simply yields an empty list here and seeds nothing.
   *
   * ## Staged, not persisted
   *
   * The seed is DERIVED from an authority that is read again on every boot, so
   * losing it costs nothing — the next boot re-derives it. `stage` therefore
   * advances the mirror without a write, which matters on this hub: the
   * pipeline-analytics runner respawns several times an hour, and persisting
   * ~500 re-derivable rows on each respawn would offer thousands of pointless
   * commits a day to the checkpoint lottery (D96). The first real
   * {@link observe} flip persists through the ordinary write-behind path.
   *
   * Returns how many rows were seeded, so the caller can say it out loud.
   */
  seedFromDirectory(
    identities: readonly {
      readonly deviceId: number
      readonly online?: boolean
    }[],
    now: number,
  ): number {
    let seeded = 0
    for (const identity of identities) {
      if (identity.online !== true) continue
      const subject = `device:${identity.deviceId}`
      if (this.ledger.has(subject)) continue
      this.ledger.stage({
        subject,
        state: 'online',
        kind: 'device-online',
        deviceId: identity.deviceId,
        updatedAt: now,
      })
      seeded += 1
    }
    return seeded
  }

  /** The in-RAM mirror, subject-ordered so two readers agree. */
  snapshot(): readonly NcLivenessRow[] {
    return this.ledger.snapshot().toSorted((a, b) => a.subject.localeCompare(b.subject))
  }

  /**
   * Drop durable `node:<node>/<child>` rows an older build left behind when
   * `worker.*` was folded into the node kinds (pre-R1-H1). A runner is not a
   * node; those subjects can never flip back to online under today's intake,
   * so an offline leftover would poison the state summary forever. Returns
   * how many rows were forgotten.
   */
  async forgetWorkerNodeSubjects(): Promise<number> {
    let forgotten = 0
    for (const row of this.ledger.snapshot()) {
      if (!row.subject.startsWith('node:') || !row.subject.includes('/')) continue
      await this.ledger.forget(row.subject)
      forgotten += 1
    }
    return forgotten
  }

  /** The state the ledger currently accepts for a subject, if any. */
  stateOf(subject: string): NcLivenessState | undefined {
    return this.ledger.get(subject)?.state
  }

  /**
   * Judge ONE observation and advance the ledger.
   *
   * Synchronous on purpose: the verdict is a function of the in-RAM mirror
   * alone, so an event can never be gated on an I/O that might fail (D49). The
   * durable write is kicked off behind it and its failure changes no verdict.
   *
   * `no-flip` leaves the row untouched — including its `updatedAt`, which
   * therefore means "when this subject last CHANGED", not "when it last
   * spoke". That is the timestamp anyone reading the table wants.
   */
  observe(observation: NcLivenessObservation, now: number): NcLivenessVerdict {
    const row: NcLivenessRow = {
      subject: observation.subject,
      state: observation.state,
      kind: observation.kind,
      ...(observation.deviceId !== undefined ? { deviceId: observation.deviceId } : {}),
      updatedAt: now,
    }
    if (!this.bootWindow.open()) return this.ledger.observe(row)
    // THE BOOT WINDOW (D698). The verdict is the same one the ledger gives —
    // a key it does not hold seeds, the same state is no flip — but a SEED is
    // provisional: persisting it would overwrite the stored row's `updatedAt`
    // with the restart's "now" before the load could read it.
    const held = this.ledger.get(row.subject)
    if (held === undefined) {
      this.bootWindow.stageProvisional(row)
      return 'seeded'
    }
    const verdict = this.ledger.observe(row)
    if (verdict === 'flip') this.bootWindow.noteWritten(row)
    return verdict
  }
}

/** The persisted column map (the `subject` PK is passed separately). */
function rowToValue(row: NcLivenessRow): Record<string, unknown> {
  return {
    state: row.state,
    kind: row.kind,
    ...(row.deviceId !== undefined ? { deviceId: row.deviceId } : {}),
    updatedAt: row.updatedAt,
  }
}

/**
 * Structurally validate one persisted record. A row whose state is not one of
 * the two known values is `null` — skipped, so the subject re-seeds cold
 * (silent) rather than hydrating a state nothing can ever equal, which would
 * make every future event a phantom flip.
 */
function recordToRow(subject: string, data: Record<string, unknown>): NcLivenessRow | null {
  if (subject.length === 0) return null
  const state = data['state']
  if (state !== 'online' && state !== 'offline') return null
  const kind = data['kind']
  if (typeof kind !== 'string' || kind.length === 0) return null
  const updatedAt = Number(data['updatedAt'])
  if (!Number.isFinite(updatedAt)) return null
  const rawDeviceId = data['deviceId']
  const deviceId =
    typeof rawDeviceId === 'number' && Number.isFinite(rawDeviceId) ? rawDeviceId : undefined
  return {
    subject,
    state,
    kind,
    ...(deviceId !== undefined ? { deviceId } : {}),
    updatedAt,
  }
}
