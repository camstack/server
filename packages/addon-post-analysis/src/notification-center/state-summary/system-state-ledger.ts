/**
 * NcSystemStateLedger — what is STILL TRUE among the event-driven system facts
 * no other ledger holds (D647).
 *
 * Battery and consumable episodes already have a durable row
 * (`alert-store.ts`), and device/node liveness has its own
 * (`liveness-ledger.ts`). The rest of the summarisable kinds are EVENTS the
 * centre hears once — a stream going offline, a device switched off, a camera
 * detecting nothing, an update becoming available — and nothing remembered
 * that they were still true. A state summary is a claim about now, so this
 * ledger keeps one row per OPEN state, fed by the same intake the instant
 * rules read, and removes it when the closing event arrives:
 *
 * | opens | closes |
 * | --- | --- |
 * | `stream-offline` | `stream-online` (same subject) |
 * | `device-disabled` | `device-enabled` (same subject) |
 * | `detection-blind` | a DETECTION on that camera — the only evidence of recovery there is |
 * | `node-inference-unavailable`, `addon-crash-loop` | the node's next liveness edge, or a server update on it |
 * | `addon-update-available` (per package, per node) | `addon.updated` for that package on that node |
 * | `server-` / `wrapper-update-available` | `server-updated` on that node |
 *
 * Two kinds have no recovery event at all (`node-inference-unavailable`,
 * `addon-crash-loop`): the orchestrator drops such a node until it comes back,
 * and a crash-looped runner stays down until something respawns it — a node
 * restart or an update. The closing edges above are those respawns. A newer
 * `update-available` for the same package REPLACES the row.
 *
 * Durable (write-behind), so a restart does not forget an outage it heard
 * about. It is fed only on the evaluating node, like the liveness ledger. The
 * summary reads the RAM mirror only — never SQLite on its schedule (D447) —
 * and a mirror that has not loaded answers `null`: the sections it feeds say
 * "unavailable", never "none" (D49).
 */
import { isDeepStrictEqual } from 'node:util'
import type { IScopedLogger, NcSystemEventKind } from '@camstack/types'
import { BootWindowRows } from '../boot-window-rows.js'
import { DurableLedger, type DurableLedgerSpec } from '../../durable/durable-ledger.js'
import { type DurableKindDeps } from '../../durable/durable-wiring.js'
import { ncDurableRecordKinds } from '../nc-durable-record-kinds.js'
import type { AddonUpdateComplete } from '../update-complete-coalescer.js'
import type { NcSystemEventSubject } from '../rule-engine.js'

/**
 * @durable class=ledger owner=notification-center
 *   write="a system state the centre accepted OPENING (a stream offline, a device switched off, a camera detecting nothing, an update available, a node that cannot infer, a crash-looped runner); its closing event deletes the row"
 *   retention="none — a row lives exactly as long as its state is open. Bounded by the installation: streams, devices, nodes and installed packages."
 */
const NC_SYSTEM_STATE_COLLECTION = 'notification-center:system-state'

const NC_SYSTEM_STATE_COLUMNS = [
  /** The state's subject (`stream:<id>`, `device-switch:<id>`,
   *  `update:addon:<node>:<package>`, ...). */
  { name: 'key', type: 'TEXT' as const, primaryKey: true, notNull: true },
  /** The OPENING kind. */
  { name: 'kind', type: 'TEXT' as const, notNull: true },
  { name: 'since', type: 'INTEGER' as const, notNull: true },
  /** Indexed: every question about a device is asked per device. */
  { name: 'deviceId', type: 'INTEGER' as const },
  { name: 'nodeId', type: 'TEXT' as const },
  { name: 'packageName', type: 'TEXT' as const },
  /** The words' facts (device name, profile, versions, addons). */
  { name: 'params', type: 'JSON' as const, notNull: true },
] as const

const NC_SYSTEM_STATE_INDEXES = [
  { name: 'idx_nc_system_state_device', columns: ['deviceId'] as const },
] as const

/** One open state. */
export interface NcSystemStateRow {
  readonly key: string
  readonly kind: NcSystemEventKind
  readonly since: number
  readonly deviceId?: number
  readonly deviceType?: string
  readonly nodeId?: string
  readonly packageName?: string
  readonly params: Readonly<Record<string, string>>
}

/** The kinds that OPEN a row. */
const NC_SYSTEM_STATE_OPENING_KINDS: readonly NcSystemEventKind[] = [
  'stream-offline',
  'device-disabled',
  'detection-blind',
  'node-inference-unavailable',
  'addon-crash-loop',
  'addon-update-available',
  'server-update-available',
  'wrapper-update-available',
]

function isOpeningKind(value: unknown): value is NcSystemEventKind {
  return NC_SYSTEM_STATE_OPENING_KINDS.some((kind) => kind === value)
}

function stringRecord(value: unknown): Readonly<Record<string, string>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry
  }
  return out
}

const NC_SYSTEM_STATE_SPEC: DurableLedgerSpec<NcSystemStateRow> = {
  collection: NC_SYSTEM_STATE_COLLECTION,
  columns: NC_SYSTEM_STATE_COLUMNS,
  indexes: NC_SYSTEM_STATE_INDEXES,
  writeMode: 'write-behind',
  keyOf: (row) => row.key,
  toValue: (row) => ({
    kind: row.kind,
    since: row.since,
    ...(row.deviceId !== undefined ? { deviceId: row.deviceId } : {}),
    ...(row.nodeId !== undefined ? { nodeId: row.nodeId } : {}),
    ...(row.packageName !== undefined ? { packageName: row.packageName } : {}),
    params: {
      ...row.params,
      ...(row.deviceType !== undefined ? { deviceType: row.deviceType } : {}),
    },
  }),
  fromRecord: (key, data) => {
    const kind = data['kind']
    const since = data['since']
    const params = stringRecord(data['params'])
    if (!isOpeningKind(kind) || typeof since !== 'number' || params === null) return null
    const deviceId = data['deviceId']
    const nodeId = data['nodeId']
    const packageName = data['packageName']
    const { deviceType, ...words } = params
    return {
      key,
      kind,
      since,
      ...(typeof deviceId === 'number' ? { deviceId } : {}),
      ...(deviceType !== undefined ? { deviceType } : {}),
      ...(typeof nodeId === 'string' ? { nodeId } : {}),
      ...(typeof packageName === 'string' ? { packageName } : {}),
      params: words,
    }
  },
  deviceIdOf: (row) => row.deviceId,
}

/** The one package row an `update-available` batch names. */
export interface NcUpdateAvailableRow {
  readonly packageName: string
  readonly currentVersion: string
  readonly latestVersion: string
  readonly nodeId?: string
}

/** The hub's own node id when an update row names none. */
export const HUB_NODE = 'hub'

/** What an `update.available` event is about. */
export type NcUpdateTarget = 'addon' | 'server' | 'wrapper'

export function isUpdateTarget(value: unknown): value is NcUpdateTarget {
  return value === 'addon' || value === 'server' || value === 'wrapper'
}

/**
 * One `update.available` event: the FULL list of what is behind, for the
 * nodes it names. Every node in `nodeIds` is REPLACED by `rows` (D647 review
 * I3): a package a later list no longer carries is current.
 *
 * THE LIMIT: the emitter sends a list only when a `latestVersion` changes, and
 * never an empty one. A package made current with no newer release anywhere
 * (so no new list) and no `addon.updated` / `server-updated` for it stays
 * listed until the next list for its node replaces it — the limit the ADR
 * records.
 */
export interface NcUpdateList {
  readonly target: NcUpdateTarget
  readonly nodeIds: readonly string[]
  readonly rows: readonly NcUpdateAvailableRow[]
}

function updateKind(target: NcUpdateTarget): NcSystemEventKind {
  return target === 'addon'
    ? 'addon-update-available'
    : target === 'server'
      ? 'server-update-available'
      : 'wrapper-update-available'
}

export function updateStateKey(
  target: NcUpdateTarget,
  nodeId: string | undefined,
  packageName: string,
): string {
  return `update:${target}:${nodeId ?? HUB_NODE}:${packageName}`
}

/**
 * One crash-looped RUNNER the ledger holds open (D708): what the summary's
 * recovery reconcile asks the runner state about. `runnerId` is read back off
 * the row's subject (`addon-crash:<nodeId>:<runnerId>`, `event-intake.ts`).
 */
export interface NcCrashLoopRunner {
  readonly key: string
  readonly nodeId: string
  readonly runnerId: string
  /** The addons the runner hosted, as the trip named them (the runner id when none). */
  readonly addonIds: readonly string[]
}

const CRASH_SUBJECT_PREFIX = 'addon-crash:'

/** The row store as the ledger needs it — a `DurableLedger` in production, a Map in a spec. */
export interface NcSystemStateRowPort {
  readonly get: (key: string) => NcSystemStateRow | undefined
  readonly put: (row: NcSystemStateRow) => void
  readonly remove: (key: string) => void
  readonly all: () => readonly NcSystemStateRow[]
  /** Has the durable store been READ once? `false` = the mirror is not the truth yet. */
  readonly answered: () => boolean
  /**
   * Keep a CLOSE to run against the loaded rows at the boot settle (D698 review
   * H1) — a close heard at boot about a row only the store holds must not be
   * lost. A no-op once settled. `key` names the close; the same key deferred
   * twice runs once. `replay` answers how many rows it closed.
   */
  readonly deferWhileOpen: (key: string, replay: () => number) => void
}

export interface NcSystemStateLedgerDeps {
  readonly rows: NcSystemStateRowPort
  readonly logger?: IScopedLogger
}

/** The current stream-row key: one per device (D883). */
const DEVICE_STREAM_KEY = /^stream:\d+$/

export class NcSystemStateLedger {
  constructor(private readonly deps: NcSystemStateLedgerDeps) {
    this.closeLegacyStreamKeys()
  }

  /**
   * One-time migration of state keys (D883): a stream row used to be keyed by
   * `stream:<camStreamId>`; it is now `stream:<deviceId>`. A row still open
   * under the old shape would never meet its `stream.online`, so it is closed
   * now and against the loaded rows. Nothing else is touched.
   */
  private closeLegacyStreamKeys(): void {
    this.closeWhere(
      'legacy-stream-keys',
      (row) => row.key.startsWith('stream:') && !DEVICE_STREAM_KEY.test(row.key),
      'legacy-stream-key',
    )
  }

  /**
   * Is this device switched off RIGHT NOW (an open `device-disabled` row)?
   * D62: the switch outranks the device's liveness and its streams — a device
   * somebody turned off is reported off, never as offline. `false` while the
   * store has never answered (unknown is never "disabled").
   */
  isDeviceDisabled(deviceId: number): boolean {
    return (this.openRows() ?? []).some(
      (row) => row.kind === 'device-disabled' && row.deviceId === deviceId,
    )
  }

  /** The open rows, or `null` while the store has never answered. */
  openRows(): readonly NcSystemStateRow[] | null {
    return this.deps.rows.answered() ? this.deps.rows.all() : null
  }

  /**
   * One system subject the intake accepted. The update-available kinds are
   * not read here: {@link observeUpdateList} replaces them from the raw event.
   */
  observe(system: NcSystemEventSubject, atMs: number): void {
    switch (system.kind) {
      case 'stream-offline':
      case 'device-disabled':
      case 'detection-blind':
      case 'node-inference-unavailable':
      case 'addon-crash-loop':
        this.open(system, atMs)
        return
      case 'stream-online':
      case 'device-enabled':
        this.close(system.subject, system.kind)
        return
      case 'node-online':
      case 'node-offline':
        if (system.nodeId !== undefined) this.closeNodeFaults(system.nodeId, system.kind)
        return
      case 'server-updated':
        if (system.nodeId !== undefined) this.closeServerUpdate(system.nodeId)
        return
      default:
        return
    }
  }

  /**
   * The crash-looped runners held open, for the recovery reconcile (D708) —
   * empty while the store has never answered (nothing to reconcile yet).
   */
  crashLoopRunners(): readonly NcCrashLoopRunner[] {
    const rows = this.openRows() ?? []
    return rows.flatMap((row) => {
      if (row.kind !== 'addon-crash-loop' || row.nodeId === undefined) return []
      const prefix = `${CRASH_SUBJECT_PREFIX}${row.nodeId}:`
      if (!row.key.startsWith(prefix)) return []
      const runnerId = row.key.slice(prefix.length)
      if (runnerId.length === 0) return []
      const named = (row.params['addons'] ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
      return [
        {
          key: row.key,
          nodeId: row.nodeId,
          runnerId,
          addonIds: named.length > 0 ? named : [runnerId],
        },
      ]
    })
  }

  /**
   * The runner state ANSWERED that this crash-looped runner is running again
   * (D708). A core block re-enabled or updated, a runner respawned by hand —
   * none of them emits the `addon.started` the registry's addons do, so the
   * row stayed open for days and every summary reported a runner that was up.
   */
  observeRunnerRunning(runner: NcCrashLoopRunner): void {
    this.close(runner.key, 'runner-running')
  }

  /** A detection on a camera: it is not blind. Called for every detection — a Map lookup. */
  observeDetection(deviceId: number): void {
    this.close(`detection-blind:${String(deviceId)}`, 'detection')
  }

  /**
   * Any `stream.online`, whatever its reason (D647 review I1). The intake gate
   * drops a `first-packet` online — a recreated broker's — because it is not
   * a recovery worth a notification; it is still proof the stream is up.
   */
  observeStreamOnline(deviceId: number): void {
    const key = `stream:${String(deviceId)}`
    // The device's row, and any row it still holds under the pre-D883
    // per-cam-stream key — one close, so one pending close across a restart.
    this.closeWhere(
      key,
      (row) =>
        row.key === key ||
        (row.deviceId === deviceId &&
          row.key.startsWith('stream:') &&
          !DEVICE_STREAM_KEY.test(row.key)),
      'stream-online',
    )
  }

  /** One `update.available` list: REPLACE the rows of every node it names. */
  observeUpdateList(list: NcUpdateList, atMs: number): void {
    const keep = new Set(
      list.rows.map((pkg) => updateStateKey(list.target, pkg.nodeId, pkg.packageName)),
    )
    for (const nodeId of list.nodeIds) {
      const prefix = `update:${list.target}:${nodeId}:`
      this.closeWhere(
        `update-list:${list.target}:${nodeId}`,
        (row) => row.key.startsWith(prefix) && !keep.has(row.key),
        'update-list',
      )
    }
    for (const pkg of list.rows) this.openUpdate(list.target, pkg, atMs)
  }

  /**
   * An addon STARTED on `nodeId` (D647 review I5): the runner hosting it is
   * up again, so a crash-loop row naming it on THAT node is over — and only
   * on that node.
   */
  observeAddonStarted(addonId: string, nodeId: string): void {
    this.closeWhere(
      `addon-started:${nodeId}:${addonId}`,
      (row) =>
        row.kind === 'addon-crash-loop' &&
        row.nodeId === nodeId &&
        (row.params['addons'] ?? '')
          .split(',')
          .map((id) => id.trim())
          .includes(addonId),
      'addon-started',
    )
  }

  /**
   * The balancer placed a camera on a node (not pinned): placement skips a
   * node that cannot infer, so the node can infer again (D647 review I5).
   */
  observeCameraPlaced(nodeId: string): void {
    this.close(`node-inference:${nodeId}`, 'camera-placed')
  }

  /** `addon.updated` — the package is current on that node. */
  observeAddonUpdated(update: AddonUpdateComplete): void {
    this.close(updateStateKey('addon', update.nodeId, update.packageName), 'addon-updated')
  }

  /** Every device that holds an open state — the deleted-device reconcile reads it. */
  deviceIds(): readonly number[] {
    const ids = new Set<number>()
    for (const row of this.deps.rows.all()) if (row.deviceId !== undefined) ids.add(row.deviceId)
    return [...ids]
  }

  /** A deleted device leaves (D633). Returns how many rows went. */
  forgetDevice(deviceId: number): number {
    const keys = this.deps.rows
      .all()
      .filter((row) => row.deviceId === deviceId)
      .map((row) => row.key)
    for (const key of keys) this.deps.rows.remove(key)
    return keys.length
  }

  private open(system: NcSystemEventSubject, atMs: number): void {
    const held = this.deps.rows.get(system.subject)
    // A repeat of an open state keeps the ORIGINAL since: "offline since 06:40"
    // must not move to 07:10 because the broker said it again.
    const since = held !== undefined && held.kind === system.kind ? held.since : atMs
    this.deps.rows.put({
      key: system.subject,
      kind: system.kind,
      since,
      ...(system.deviceId !== undefined ? { deviceId: system.deviceId } : {}),
      ...(system.deviceType !== undefined ? { deviceType: system.deviceType } : {}),
      ...(system.nodeId !== undefined ? { nodeId: system.nodeId } : {}),
      params: system.textParams ?? {},
    })
  }

  private openUpdate(target: NcUpdateTarget, pkg: NcUpdateAvailableRow, atMs: number): void {
    const key = updateStateKey(target, pkg.nodeId, pkg.packageName)
    const held = this.deps.rows.get(key)
    const kind = updateKind(target)
    this.deps.rows.put({
      key,
      kind,
      since: held?.since ?? atMs,
      ...(pkg.nodeId !== undefined ? { nodeId: pkg.nodeId } : {}),
      packageName: pkg.packageName,
      params: {
        packageName: pkg.packageName,
        currentVersion: pkg.currentVersion,
        latestVersion: pkg.latestVersion,
        ...(pkg.nodeId !== undefined ? { nodeId: pkg.nodeId } : {}),
      },
    })
  }

  /**
   * Close one state: the row held now (a loaded one, or one opened in the boot
   * window), and — deferred while the boot window is open — the STORED row
   * the window cannot see yet (D698 review H1).
   */
  private close(key: string, by: string): void {
    this.closeIfHeld(key, by, false)
    this.deps.rows.deferWhileOpen(`close:${key}`, () => (this.closeIfHeld(key, by, true) ? 1 : 0))
  }

  /** {@link close} for every row a predicate names — now, and against the loaded rows. */
  private closeWhere(key: string, names: (row: NcSystemStateRow) => boolean, by: string): void {
    const run = (replayed: boolean): number => {
      let closed = 0
      for (const row of this.deps.rows.all()) {
        if (names(row) && this.closeIfHeld(row.key, by, replayed)) closed += 1
      }
      return closed
    }
    run(false)
    this.deps.rows.deferWhileOpen(`where:${key}`, () => run(true))
  }

  /** Close the row if one is held; `true` when it was. */
  private closeIfHeld(key: string, by: string, replayed: boolean): boolean {
    const held = this.deps.rows.get(key)
    if (held === undefined) return false
    this.deps.rows.remove(key)
    const line = {
      ...(held.deviceId !== undefined ? { tags: { deviceId: held.deviceId } } : {}),
      meta: { key, kind: held.kind, by, since: held.since },
    }
    if (replayed) {
      // Said at INFO: a state the restart would otherwise have reported open
      // forever, closed by an event heard before the load.
      this.deps.logger?.info('system state closed by an event heard before the load', line)
      return true
    }
    this.deps.logger?.debug('system state closed', line)
    return true
  }

  private closeNodeFaults(nodeId: string, by: string): void {
    this.closeWhere(
      `node-faults:${nodeId}`,
      (row) =>
        row.nodeId === nodeId &&
        (row.kind === 'node-inference-unavailable' || row.kind === 'addon-crash-loop'),
      by,
    )
  }

  private closeServerUpdate(nodeId: string): void {
    this.closeWhere(
      `server-update:${nodeId}`,
      (row) =>
        (row.nodeId ?? HUB_NODE) === nodeId &&
        (row.kind === 'server-update-available' ||
          row.kind === 'wrapper-update-available' ||
          row.kind === 'addon-crash-loop' ||
          row.kind === 'node-inference-unavailable'),
      'server-updated',
    )
  }
}

/** The durable home of the rows. */
export class NcSystemStateStore {
  private readonly ledger: DurableLedger<NcSystemStateRow>
  /**
   * What the intake opened or closed before the boot load answered (D698,
   * `boot-window-rows.ts`). A stored row of the same KIND keeps its own
   * `since`: a stream re-announced offline at boot was not offline "since the
   * restart".
   */
  private readonly bootWindow: BootWindowRows<NcSystemStateRow>

  constructor(deps: DurableKindDeps & { readonly logger: IScopedLogger }) {
    this.ledger = new DurableLedger({
      spec: NC_SYSTEM_STATE_SPEC,
      kind: deps.records.kind(ncDurableRecordKinds['system-state']),
      logger: deps.logger,
    })
    this.bootWindow = new BootWindowRows({
      ledger: this.ledger,
      keyOf: (row) => row.key,
      deviceIdOf: (row) => row.deviceId,
      logger: deps.logger,
      // The stored row's SINCE survives (the restart learned nothing about when
      // the state began); the fresh facts (a newer version, a renamed device)
      // are taken (review M1). An identical fact keeps the stored row: no write.
      merge: (stored, provisional) => {
        if (stored === undefined || stored.kind !== provisional.kind) return provisional
        const merged = { ...provisional, since: stored.since }
        return isDeepStrictEqual(merged, stored) ? stored : merged
      },
    })
  }

  /** Boot reseed. A failed load keeps the mirror and leaves `answered` false. */
  async load(): Promise<number> {
    const loaded = (await this.ledger.load()).length
    this.bootWindow.settle()
    return loaded
  }

  /** Drop a deleted device's mirrored rows (the durable ones go by `deleteWhere`, D871). */
  evictDevice(deviceId: number): number {
    return this.ledger.evictDevice(deviceId)
  }

  port(): NcSystemStateRowPort {
    return {
      get: (key) => this.ledger.get(key),
      put: (row) => {
        // Inside the boot window an open is PROVISIONAL — never persisted
        // over a stored row the load has not read yet (D698).
        if (this.bootWindow.open()) {
          this.bootWindow.stageProvisional(row)
          return
        }
        void this.ledger.put(row).catch(() => undefined)
      },
      remove: (key) => {
        if (this.bootWindow.open()) this.bootWindow.noteRemoved(key)
        void this.ledger.forget(key)
      },
      all: () => this.ledger.snapshot(),
      answered: () => this.ledger.hasAnswered(),
      deferWhileOpen: (key, replay) => this.bootWindow.deferWhileOpen(key, replay),
    }
  }
}
