/**
 * Routing core for the `storage-orchestrator` builtin.
 *
 * Owns the in-memory `locationId → StorageLocation` map and the
 * `(providerId, nodeId) → IStorageProviderImpl` lookup. Every consumer-facing
 * `storage` cap call lands here:
 *   1. `resolveRef(ref)` — bare type or fully-qualified id → concrete location
 *   2. `getProviderFor(location)` — route `(providerId, nodeId)` to either a
 *      local `storage-provider` registrant or the provider ON the node the
 *      location lives on. `providerId` alone is NOT a routing key: every
 *      node's filesystem provider shares it.
 *   3. `getProviderForSession(kind, id)` — the same routing for chunked I/O,
 *      which carries no location after the opening call.
 *
 * The provider lookup is injected (`getProviders`) so unit tests can
 * pass fixtures without booting a real CapabilityRegistry. The addon
 * wires the production lookup to
 * `ctx.kernel.capabilityRegistry?.getCollection<IStorageProviderImpl>('storage-provider')`.
 *
 * Task 5 adds first-boot seeding of default locations from addon-declared
 * location types (providers no longer gate by type).
 * Task 6 adds an optional `ILocationStore` for SQLite persistence —
 * `initialize()` hydrates the in-memory map from the store, and every
 * `upsertLocation` / `deleteLocation` mirrors the change to the store.
 * Tests pass `null` (or a fake `ILocationStore`) for in-memory-only
 * operation; production wires `SqliteLocationStore`.
 */

import * as path from 'node:path'
import type {
  IScopedLogger,
  IStorageProviderImpl,
  StorageAccess,
  StorageLocation,
  StorageLocationDeclaration,
  StorageLocationMode,
  StorageLocationRef,
} from '@camstack/types'
import {
  isLocationEnabled,
  legacyModeOf,
  mayWriteToLocation,
  modeMayWrite,
  resolveLocationMode,
  STORAGE_ACCESS_FALLBACK,
  withLocationMode,
} from '@camstack/types'
import { physicalRootOf } from '@camstack/types/node'
import type { ResolveRoot } from './location-root-collision.js'
import { findRootCollision, rootCollisionMessage } from './location-root-collision.js'
import type { ILocationStore, PersistedStorageLocation } from './location-store.js'

export interface ListLocationsFilter {
  // Open string — location *type* is now a declaration-driven id, not a
  // member of the closed `StorageLocationType` enum. Enum values remain
  // valid (they're plain strings).
  readonly type?: string
}

/**
 * Minimal structural shape the orchestrator needs from the kernel's
 * `StorageLocationRegistry` — the cardinality lookup plus the full
 * declaration list (the admin-UI Data screen renders one group per
 * declaration). Declared locally so core's builtins don't import the
 * kernel's registry type directly; the addon passes the real
 * `buildStorageLocationRegistry(...)` result, which structurally
 * satisfies this interface.
 */
export interface DeclarationSource {
  cardinalityOf(id: string): 'single' | 'multi' | null
  /**
   * Effective {@link StorageAccess} of a declared location kind — the
   * constraint that decides which providers may back it. `null` = the kind
   * was never declared. See `upsertLocation`'s remote-provider refusal.
   */
  accessOf(id: string): StorageAccess | null
  list(): readonly StorageLocationDeclaration[]
}

/**
 * Provider lookup callback. Returns the live set of `storage-provider`
 * registrants. Called per-dispatch (cheap registry scan) so newly
 * loaded addons surface immediately.
 */
export type StorageProviderLookup = () => readonly IStorageProviderImpl[]

/**
 * Synchronous `providerId → nodeLocal` resolver, injected by the addon
 * from a cached snapshot of `storage-provider.getProviderInfo()` (the
 * `getProviderInfo` round-trip is async, so a sync cache keeps
 * `upsertLocation` synchronous — the contract its many callers rely on).
 *
 * Returns:
 *   - `true`  — node-local provider (filesystem): its locations bind to a
 *     single node, so a `nodeId` is required.
 *   - `false` — node-agnostic provider (S3/SFTP/WebDAV): `nodeId` optional.
 *   - `undefined` — provider not (yet) known. Treated as non-node-local:
 *     validation does not reject (the provider may register later / be
 *     remote), the safe default for the early-boot / in-memory path.
 */
export type NodeLocalResolver = (providerId: string) => boolean | undefined

/**
 * Whether a location still holds anything — the only question `deleteLocation`
 * is allowed to destroy a record on the answer to.
 *
 *  - `'occupied'` — something is there. Deleting the record now strands it.
 *  - `'empty'`    — the location was reached and holds nothing.
 *  - `'unknown'`  — it could not be reached at all: a remote provider, another
 *                   node's disk, an unmounted root. NOT "empty". A read that
 *                   fails must never authorise a destruction (D49).
 */
export type LocationOccupancy = 'occupied' | 'empty' | 'unknown'
export type LocationOccupancyProbe = (location: StorageLocation) => Promise<LocationOccupancy>

export interface DeleteLocationOptions {
  /** Override an `occupied` or `unknown` verdict. See the cap docblock. */
  readonly force?: boolean
}

/**
 * Where a single dispatch must execute: which `storage-provider`, on which
 * node. `providerId` alone is NOT a routing key — every node's filesystem
 * provider registers under the same id, so a target without its `nodeId`
 * silently resolves to whichever node asked (the hub).
 *
 * `nodeId` absent = node-agnostic (S3/SFTP/WebDAV): reachable from anywhere,
 * so the local provider runs it.
 */
export interface StorageDispatchTarget {
  readonly providerId: string
  readonly nodeId?: string
}

/** The two chunked-I/O session families the orchestrator tracks. */
export type StorageSessionKind = 'upload' | 'download'

/** Per-kind wording for the session error messages (operator-facing). */
interface SessionVocabulary {
  readonly idLabel: string
  readonly openMethod: string
}

const SESSION_VOCABULARY: Readonly<Record<StorageSessionKind, SessionVocabulary>> = {
  upload: { idLabel: 'uploadId', openMethod: 'beginUpload' },
  download: { idLabel: 'downloadId', openMethod: 'beginDownload' },
}

/** Map key for a tracked chunked session — the id spaces never collide. */
function sessionKey(kind: StorageSessionKind, sessionId: string): string {
  return `${kind}:${sessionId}`
}

/**
 * Bare node id for a raw kernel `localNodeId`. Forked children carry a
 * `<node>/<addon>` suffix; routing is per-NODE, so the addon segment is
 * dropped. (Mirrors `normalizeNodeId` in `@camstack/types/addon`, which is a
 * leaf module not re-exported on any subpath this package can import.)
 */
function bareNodeId(raw: string | undefined): string {
  if (raw === undefined || raw === '') return 'hub'
  const slash = raw.indexOf('/')
  if (slash < 0) return raw
  const bare = raw.slice(0, slash)
  return bare === '' ? 'hub' : bare
}

/** What a {@link StorageOrchestratorService.seedDefaults} pass did. */
export type SeedOutcome = {
  readonly added: number
  readonly deferred?: 'store-not-answered' | 'provider-unclassified'
}

export class StorageOrchestratorService {
  private readonly locations: Map<string, StorageLocation> = new Map()

  /**
   * Declaration-driven cardinality source, injected by the addon after
   * the kernel aggregates `storageLocations` declarations. `null` until
   * `setRegistry` runs — `upsertLocation` then treats every type as
   * `'multi'` (no singleton enforcement), the safe default for the
   * in-memory-only / early-boot path.
   */
  private registry: DeclarationSource | null = null

  /**
   * Injected `providerId → nodeLocal` resolver (see {@link NodeLocalResolver}).
   * `null` until {@link setNodeLocalResolver} runs — `upsertLocation` then
   * skips the node-local requirement check entirely (every provider is
   * treated as node-agnostic), the safe default for the in-memory-only /
   * early-boot path that predates the resolver wiring.
   */
  private nodeLocalResolver: NodeLocalResolver | null = null

  /**
   * Injected occupancy probe (see {@link LocationOccupancyProbe}). `null` until
   * {@link setOccupancyProbe} runs, and a `null` probe answers `unknown` — so a
   * service with no probe REFUSES an unforced delete rather than performing one
   * it could not check. The check is the point; a check that defaults to
   * "permit" is a paragraph, not a guard.
   */
  private occupancyProbe: LocationOccupancyProbe | null = null

  /** `localNodeId` with any forked-child `/addon` suffix stripped. */
  private readonly localNode: string

  /**
   * `<kind>:<sessionId>` → the dispatch target that OPENED the session.
   * Chunked I/O carries no `StorageLocation` after the first hop, so without
   * this the follow-up chunks fall back to a `providerId`-only lookup — which
   * on a multi-node cluster means the hub's filesystem, not the agent's.
   */
  private readonly sessionTargets: Map<string, StorageDispatchTarget> = new Map()

  constructor(
    private readonly logger: IScopedLogger,
    private readonly getProviders: StorageProviderLookup,
    /**
     * Optional persistence backend. When supplied, `initialize()`
     * hydrates the in-memory map from the store, and every mutation
     * (upsert/delete) mirrors to it. When `null` / `undefined`, the
     * service is in-memory only — the contract used by the existing
     * routing tests, where re-creating the service deliberately
     * forgets every location.
     *
     * Mutable because production boot wires it late: the `settings-store`
     * cap often isn't registered when the orchestrator initializes, so the
     * service starts store-less and the addon calls {@link attachStore} once
     * the provider appears. See {@link attachStore}.
     */
    private locationStore: ILocationStore | null = null,
    /** This node's id — locations pinned to OTHER nodes dispatch remotely. */
    localNodeId: string = 'hub',
    /** Cross-node provider resolver (hub wiring: a node-routed capability
     *  proxy over `storage-provider`). Absent → remote locations error. */
    private readonly getRemoteProvider?: (nodeId: string) => IStorageProviderImpl | null,
  ) {
    this.localNode = bareNodeId(localNodeId)
  }

  /**
   * The node this orchestrator runs on, with any forked-child `/addon`
   * suffix stripped. A location whose `nodeId` differs is NOT this node's
   * to touch — its bytes, and its free space, live elsewhere.
   */
  getLocalNodeId(): string {
    return this.localNode
  }

  /**
   * Whether a seed must wait for an ANSWERED read of the store (D49). True on a
   * node whose locations live in a store: seeding before that read lands writes
   * defaults the store's own rows (not yet adopted, or not yet read) then
   * contradict. False on a node that has no store by design — it seeds in memory
   * at every boot.
   */
  private storeRequiredForSeed = false

  setStoreRequiredForSeed(required: boolean): void {
    this.storeRequiredForSeed = required
  }

  /**
   * The location types a default was ever seeded for — null when the store
   * cannot remember (then a type with no row is seeded, as before). What makes
   * an operator's delete of a seeded default STICK: zero rows today is not
   * "fresh install", it is only fresh when nothing was ever seeded.
   */
  private seededTypes: Set<string> | null = null
  /** The store held locations but no seed memory: an install older than the memory. */
  private installPredatesSeedMemory = false

  private async loadSeedMemory(store: ILocationStore, rowCount: number): Promise<void> {
    if (!store.loadSeededTypes) return
    const types = await store.loadSeededTypes()
    this.seededTypes = new Set(types)
    this.installPredatesSeedMemory = types.length === 0 && rowCount > 0
  }

  private rememberSeeded(type: string): void {
    const seeded = this.seededTypes
    const store = this.locationStore
    if (seeded === null || seeded.has(type) || !store?.markTypeSeeded) return
    seeded.add(type)
    void store.markTypeSeeded(type).catch((err) => {
      this.logger.error('storage-orchestrator: persisting the seed memory failed', {
        meta: { type, error: err instanceof Error ? err.message : String(err) },
      })
    })
  }

  /** True once a persistence store is wired (constructor or {@link attachStore}). */
  hasStore(): boolean {
    return this.locationStore !== null
  }

  /**
   * Late-bind the persistence store (production boot: the `settings-store`
   * cap registers after the orchestrator initializes, so the service runs
   * in-memory-only until then). Idempotent — a second call once a store is
   * wired is a no-op.
   *
   * Reconciles both directions so operator edits survive a reboot:
   *   1. hydrate — DB rows win over any early in-memory seed (restores
   *      operator config like `minFreePercent` that the pre-store boot
   *      can't see);
   *   2. backfill — in-memory locations the DB doesn't have yet (the
   *      pre-store seed defaults on a fresh install) are persisted, so the
   *      store becomes the durable source of truth from here on.
   *
   * **The re-entry guard latches on a SUCCESSFUL hydrate, not on the attempt** —
   * `loadAll()` is awaited BEFORE `this.locationStore` is assigned, and the
   * order is load-bearing. Latching first meant one transient read error
   * answered `hasStore()` true forever, so the addon's `ensureStoreWired` gate
   * skipped every retry; the service then ran the whole process lifetime on
   * pre-store seed defaults while `upsert` mirrored them onto rows it had never
   * read, silently replacing the operator's persisted `minFreePercent`. Failing
   * back to store-less is the safe direction: an in-memory-only service writes
   * nothing over what is on disk, and the next `capability:provider-registered`
   * event tries again. Held by
   * `__tests__/storage-orchestrator-persistence.spec.ts`.
   */
  async attachStore(store: ILocationStore): Promise<void> {
    if (this.locationStore) return
    const rows = await store.loadAll()
    await this.loadSeedMemory(store, rows.length)
    this.locationStore = store
    const dbIds = new Set(rows.map((r) => r.id))
    for (const loc of rows) {
      this.locations.set(loc.id, loc)
    }
    // Backfill in-memory-only locations (pre-store seed) into the store.
    const backfill = [...this.locations.values()].filter((l) => !dbIds.has(l.id))
    for (const loc of backfill) {
      void store.upsert(loc).catch((err) => {
        this.logger.warn('storage-orchestrator: attachStore backfill persist failed', {
          meta: {
            id: loc.id,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      })
    }
    this.logger.info('storage-orchestrator: store attached + reconciled', {
      meta: {
        hydrated: rows.length,
        backfilled: backfill.length,
        total: this.locations.size,
      },
    })
    this.migrateOntoTheWriteSet(rows)
  }

  /**
   * ONE explicit migration onto the four-state model (D385), run once per boot
   * against the rows that came off disk. Idempotent: the second boot finds
   * nothing to do.
   *
   * Two steps, in order, and each one is a WRITE — the point is that "absent"
   * stops existing rather than being re-interpreted on every read forever:
   *
   *   1. A row with no `mode` is stamped with the mode its legacy flags imply
   *      (`legacyModeOf`): `config.readOnly === true` → `readonly` and the
   *      config key is DELETED; `enabled === false` → `readonly` (the
   *      CONSERVATIVE direction — a state change must never start deleting
   *      footage on its own); everything else → `active`. `withLocationMode`
   *      derives `enabled` from the mode, so the two can never disagree, and
   *      this subsumes the D383 pass that stamped flagless rows `enabled: true`.
   *   2. A type left with NO write target — only reachable from a hand-edited
   *      store or a row an older build wrote — gets one made `active`, chosen as
   *      the row the RETIRED default flag named, else the `:default`-slugged
   *      row, else the lexicographically first. Loudly: a class with no write
   *      target records nowhere, and refusing to repair it here would leave the
   *      hub silently unable to write with no operator action pending.
   *
   * An operator's explicit `readonly`/`drain`/`disabled` is never reversed by
   * step 1 — only step 2 touches it, and only when the alternative is a class
   * that cannot write at all.
   *
   * On the live hub every location is enabled with no `readOnly`, so step 1 is
   * a no-op that stamps `active` and nothing else changes.
   */
  private migrateOntoTheWriteSet(rows: readonly PersistedStorageLocation[]): void {
    const legacyDefaultOfType = new Map<string, string>()
    for (const row of rows) if (row.isDefault === true) legacyDefaultOfType.set(row.type, row.id)

    const stamped: string[] = []
    // Re-`set`ting an EXISTING key during iteration is defined behaviour (the
    // entry keeps its position), and this loop only ever replaces rows it has
    // already visited.
    for (const loc of this.locations.values()) {
      if (loc.mode !== undefined) continue
      this.persistMigrated(withLocationMode(loc, legacyModeOf(loc) ?? 'active'))
      stamped.push(loc.id)
    }

    const repaired: string[] = []
    for (const type of new Set([...this.locations.values()].map((l) => l.type))) {
      const ofType = [...this.locations.values()].filter((l) => l.type === type)
      if (ofType.some((l) => isLocationEnabled(l))) continue
      const legacyDefault = legacyDefaultOfType.get(type)
      const pick =
        ofType.find((l) => l.id === legacyDefault) ??
        ofType.find((l) => l.id === `${type}:default`) ??
        ofType.toSorted((a, b) => a.id.localeCompare(b.id))[0]
      if (!pick) continue
      this.persistMigrated(withLocationMode(pick, 'active'))
      repaired.push(pick.id)
    }

    if (stamped.length > 0 || repaired.length > 0) {
      this.logger.info('storage-orchestrator: migrated locations onto the state model', {
        meta: { stamped, repaired },
      })
    }
    for (const id of repaired) {
      this.logger.warn(
        'storage-orchestrator: a storage type had NO enabled location — re-enabled one so it can ' +
          'write. Every other location of that type stays read-only until you enable it.',
        { meta: { id } },
      )
    }
  }

  /** Apply one migrated row in memory and mirror it to the store. */
  private persistMigrated(next: StorageLocation): void {
    const withStamp: StorageLocation = { ...next, updatedAt: Date.now() }
    this.locations.set(withStamp.id, withStamp)
    const store = this.locationStore
    if (!store) return
    void store.upsert(withStamp).catch((err) => {
      this.logger.error('storage-orchestrator: state-model migration persist failed', {
        meta: { id: withStamp.id, error: err instanceof Error ? err.message : String(err) },
      })
    })
  }

  /**
   * Inject the declaration-driven cardinality source. Called once by the
   * addon after the kernel aggregates every addon's `storageLocations`
   * declarations into a `StorageLocationRegistry`.
   */
  setRegistry(registry: DeclarationSource | null): void {
    this.registry = registry
  }

  /**
   * Inject the synchronous `providerId → nodeLocal` resolver (SP1). Called
   * by the addon from a cached snapshot of every `storage-provider`'s
   * `getProviderInfo().nodeLocal`, refreshed when the provider collection
   * changes. Powers the node-local upsert guard and the boot backfill.
   */
  setNodeLocalResolver(resolver: NodeLocalResolver | null): void {
    this.nodeLocalResolver = resolver
  }

  /**
   * Inject the "does this location still hold anything" probe read by
   * {@link deleteLocation}. Absent → every delete sees `unknown` and therefore
   * REFUSES without `force`, which is the safe direction for a service wired
   * without one.
   */
  setOccupancyProbe(probe: LocationOccupancyProbe | null): void {
    this.occupancyProbe = probe
  }

  /**
   * The full set of addon-declared storage locations, as aggregated by
   * the kernel and injected via {@link setRegistry}. Powers the admin-UI
   * Data screen's per-declaration grouping. Empty until the registry is
   * injected (early-boot / in-memory-only path).
   */
  listDeclarations(): readonly StorageLocationDeclaration[] {
    return this.registry ? this.registry.list() : []
  }

  /**
   * Hydrate the in-memory map from the persistence layer. Called once
   * by the addon during `onInitialize`, before the eager seed pass.
   * Idempotent — running it twice with the same store contents
   * produces the same map. No-op when the service was constructed
   * without a store.
   *
   * Errors loading individual rows are tolerated: the bad row is
   * skipped and logged so a single corrupted record doesn't lock the
   * whole orchestrator out of boot. (The store-side validation pass
   * before insert means only schema-invalid SQL state can produce
   * such a row.)
   */
  async initialize(): Promise<void> {
    if (!this.locationStore) return
    const rows = await this.locationStore.loadAll()
    await this.loadSeedMemory(this.locationStore, rows.length)
    for (const loc of rows) {
      this.locations.set(loc.id, loc)
    }
    this.logger.info('storage-orchestrator: hydrated locations from store', {
      meta: { loaded: this.locations.size },
    })
    this.migrateOntoTheWriteSet(rows)
  }

  /**
   * Boot backfill (SP1): stamp `nodeId` on every persisted node-local
   * location that lacks one. Single-node deployments seeded their
   * filesystem locations before `nodeId` existed — they live on `hubNodeId`
   * (the hub). Node-agnostic (remote) locations are left untouched: their
   * absent `nodeId` is correct (reachable from any node).
   *
   * Idempotent — a location that already carries a `nodeId` (any value) is
   * never re-touched, so re-running on a populated map (or a re-boot) is a
   * no-op. A plain local update, not versioned-migration machinery: only
   * the rows missing `nodeId` are mutated + persisted.
   *
   * No-op until the node-local resolver is wired (it classifies which
   * providers are node-local).
   */
  async backfillNodeIds(hubNodeId: string): Promise<void> {
    const resolver = this.nodeLocalResolver
    if (!resolver) return
    let stamped = 0
    for (const [id, loc] of Array.from(this.locations)) {
      if (loc.nodeId) continue // already stamped → idempotent skip
      if (resolver(loc.providerId) !== true) continue // node-agnostic / unknown → leave null
      const updated: StorageLocation = {
        ...loc,
        nodeId: hubNodeId,
        updatedAt: Date.now(),
      }
      this.locations.set(id, updated)
      stamped++
      if (this.locationStore) {
        try {
          await this.locationStore.upsert(updated)
        } catch (err) {
          this.logger.error('storage-orchestrator: nodeId backfill persist failed', {
            meta: {
              id,
              error: err instanceof Error ? err.message : String(err),
            },
          })
        }
      }
    }
    if (stamped > 0) {
      this.logger.info('storage-orchestrator: backfilled nodeId on node-local locations', {
        meta: { stamped, hubNodeId },
      })
    }
  }

  // ── Location CRUD ─────────────────────────────────────────────────────

  listLocations(filter?: ListLocationsFilter): readonly StorageLocation[] {
    const all = [...this.locations.values()]
    return filter?.type ? all.filter((l) => l.type === filter.type) : all
  }

  /**
   * The WRITE SET of a type: every enabled location of it, in stable id order.
   * This replaced `getDefaultLocation` (D383) — a type does not have one write
   * target any more, it has a pool, and every consumer that must pick one picks
   * from here by its own rule (the recorder by headroom, a drain by an operator
   * -named destination).
   */
  writeTargets(type: string): readonly StorageLocation[] {
    return [...this.locations.values()]
      .filter((loc) => loc.type === type && isLocationEnabled(loc))
      .toSorted((a, b) => a.id.localeCompare(b.id))
  }

  /**
   * Change the WRITE SET as one compensated commit: each named location is
   * enabled (it joins the pool) or disabled (it becomes read-only — still read,
   * still played back, still age-swept, still drained).
   *
   * This is the cutover verb, and its only caller is the migration coordinator,
   * which persists its `repointing` phase BEFORE calling so a crash mid-write
   * is recovered by replaying the same idempotent set before writers resume.
   *
   * It moves ONLY the locations it is given: a cutover from A to C on a class
   * that also writes to B leaves B in the pool, because the operator's pool is
   * the authority and a migration is not a licence to shrink it. The commit is
   * refused when it would leave a write-serving type with nothing enabled —
   * the same refusal `upsertLocation` applies, judged on the RESULT so an
   * enable and a disable in one commit are weighed together.
   */
  async setWriteTargets(enabledByLocationId: ReadonlyMap<string, boolean>): Promise<void> {
    if (enabledByLocationId.size === 0) return
    const now = Date.now()
    const nextById = new Map(this.locations)
    const touched = new Map<string, StorageLocation>()

    for (const [id, enabled] of enabledByLocationId) {
      const location = nextById.get(id)
      if (!location) throw new Error(`Storage location "${id}" not found`)
      if (isLocationEnabled(location) === enabled) continue
      // Enabling joins the write pool; disabling makes the location READ-ONLY —
      // still read, still played back, still age-swept. Never `drain` and never
      // `disabled`: a cutover is not a licence to start erasing the source.
      const updated: StorageLocation = withLocationMode(
        { ...location, updatedAt: now },
        enabled ? 'active' : 'readonly',
      )
      nextById.set(id, updated)
      touched.set(id, updated)
    }
    if (touched.size === 0) return
    refuseTypeWithoutWriteTarget(touched.values(), nextById.values())

    if (this.locationStore) {
      const previous = new Map<string, StorageLocation>()
      for (const id of touched.keys()) {
        const location = this.locations.get(id)
        if (location) previous.set(id, location)
      }
      try {
        for (const location of touched.values()) await this.locationStore.upsert(location)
      } catch (err) {
        // The backing stores currently expose single-row writes, not a
        // transaction. Compensate before exposing any changed in-memory write
        // set; a durable `repointing` coordinator state retries on boot.
        for (const location of previous.values()) {
          try {
            await this.locationStore.upsert(location)
          } catch {
            // Recovery will reconcile this exact target set before resume.
          }
        }
        throw err
      }
    }
    this.locations.clear()
    for (const [id, location] of nextById) this.locations.set(id, location)
  }

  /**
   * Insert or update a location.
   *
   * When a persistence store is wired (Task 6), the record is mirrored to it;
   * the mirror is fire-and-forget and its errors reach the logger.
   */
  /**
   * Refuse a `(location kind, provider)` pair the kind cannot use.
   *
   * The rule, in one line: a `'local-path'` kind requires a provider whose
   * `getProviderInfo().nodeLocal` is `true`.
   *
   * `nodeLocal` is the honest name for "this provider's `resolve` returns a
   * path on the filesystem of the node that resolved it". The
   * `storage-provider` cap's own discriminated union already forces every
   * provider to declare it, and all four remote providers declare `false`, so
   * no new cap surface is needed to ask the question.
   *
   * Three-valued on purpose. Only a POSITIVE `false` refuses:
   *  - `true`      → node-local, always fine.
   *  - `false`     → the provider is known and known to be remote. REFUSE.
   *  - `undefined` → the provider has not registered yet (early boot, an addon
   *    still loading). That is "unknown", not "remote", and a read that could
   *    not be made must never destroy work (D49) — the system seed runs
   *    through this path before any provider registers. Allowed, and logged,
   *    so the allowance is never silent.
   *
   * The DECLARATION side is read the same way. A kind the registry does not
   * know is `local-path` (fail-closed: an unknown kind is not a permissive
   * one), but NO REGISTRY AT ALL is a different statement — nothing has been
   * loaded, so nothing can be concluded about any kind. The addon injects the
   * registry inside `onInitialize`, before the `storage` cap is mounted, so
   * there is no window in which an operator upsert sees this branch; a service
   * constructed without one is the in-memory/early-boot path.
   */
  private refuseIncompatibleProvider(
    input: Omit<StorageLocation, 'createdAt' | 'updatedAt'>,
  ): void {
    const registry = this.registry
    if (registry === null) {
      this.logger.debug(
        'storage-orchestrator: no location declarations loaded — access constraint not evaluated',
        { meta: { id: input.id, type: input.type, providerId: input.providerId } },
      )
      return
    }
    const access: StorageAccess = registry.accessOf(input.type) ?? STORAGE_ACCESS_FALLBACK
    if (access !== 'local-path') return

    const nodeLocal = this.nodeLocalResolver?.(input.providerId)
    if (nodeLocal === true) return
    if (nodeLocal === undefined) {
      this.logger.debug(
        'storage-orchestrator: provider not yet classified — allowing a local-path upsert',
        { meta: { id: input.id, type: input.type, providerId: input.providerId, access } },
      )
      return
    }

    this.logger.warn('storage-orchestrator: REFUSED a remote provider for a local-path kind', {
      meta: { id: input.id, type: input.type, providerId: input.providerId, access },
    })
    throw new Error(
      `Storage kind "${input.type}" is declared access "local-path": the service that owns it ` +
        `reads and writes its bytes with node:fs on the path "storage.resolve" returns, so it ` +
        `can only be backed by a node-local provider. Provider "${input.providerId}" is remote ` +
        `(nodeLocal: false) and its resolved paths do not exist on this node. ` +
        `Refusing location "${input.id}".`,
    )
  }

  upsertLocation(input: Omit<StorageLocation, 'createdAt' | 'updatedAt'>): StorageLocation {
    const now = Date.now()
    const existing = this.locations.get(input.id)

    // Cardinality guard — singleton types reject "Add" attempts (an
    // upsert with no matching `id` already in the map). Editing the
    // existing singleton is fine; adding a parallel one would split
    // state in a way consumers can't reconcile (two `addons-data`
    // roots, two `data` paths for sqlite, …).
    if (!existing) {
      // Declaration-driven cardinality. `'single'` rejects "Add"
      // attempts (an upsert with no matching `id` already in the map);
      // a missing declaration (or no registry yet) defaults to `'multi'`.
      const cardinality = this.registry?.cardinalityOf(input.type) ?? 'multi'
      if (cardinality === 'single') {
        const already = [...this.locations.values()].find((l) => l.type === input.type)
        if (already) {
          throw new Error(
            `Storage type "${input.type}" is single — only one location allowed (existing: "${already.id}"). Edit it instead of adding a new one.`,
          )
        }
      }
    }
    // ── The service/location-kind constraint (D296) ──────────────────
    // A kind whose declaring service does raw `node:fs` on the output of
    // `storage.resolve` CANNOT be backed by a provider that serves a remote
    // host: `resolve` would hand back a path on the REMOTE machine, which the
    // recorder then opens locally — against nothing, or against a same-named
    // local directory that is something else entirely. A recording write that
    // goes to the wrong place surfaces as a silent black window, not an error.
    //
    // Refused HERE, at the moment the operator points a kind at a provider,
    // rather than discovered at the first write.
    this.refuseIncompatibleProvider(input)

    // Node-local default (SP1) — a node-local provider's location binds to one
    // node's disk. When no node is given (the system seed of `*:default`
    // locations runs through here BEFORE the backfill and is node-blind),
    // default to the hub — the single-node default. The admin UI always picks a
    // node (defaulting to hub); multi-node (SP2) sets a real node. An unknown
    // (`undefined`) or node-agnostic (`false`) provider is left as-is.
    if (this.nodeLocalResolver?.(input.providerId) === true && !input.nodeId) {
      input = { ...input, nodeId: 'hub' }
    }

    // Operator opt-in (`enabled`). Three rules, in this order:
    //   1. An EXPLICIT value always wins — the operator said so.
    //   2. On an UPDATE, an omitted value preserves what is stored (including
    //      "stored nothing", which is a legacy row and means active). A rename
    //      or a path edit must never flip a live write target.
    //   3. On a CREATE, an omitted value is `false` — creating a disk must not
    //      start writing to it — UNLESS it is the FIRST location of its type,
    //      where there is nothing else that could serve.
    // Disabling the last enabled location of a write-serving type is refused
    // after this patch is applied, not by forcing the default on.
    // Two locations of the SAME type on one physical root (D389). Refused at
    // the door, with the id it collides with and the shared root — the
    // recorder's `demoteWritableAliasConflicts` is the late parachute and stays
    // for rows created before this check existed.
    this.refuseSameTypeRootCollision(input, existing)

    const next: StorageLocation = withLocationMode(
      {
        ...input,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      },
      resolveUpsertMode(input, existing, this.hasAnyLocationOfType(input.type)),
    )
    refuseLastWriteTargetDisabled(existing, next, this.locations.values())
    this.locations.set(next.id, next)
    this.logger.debug('storage-orchestrator: upsertLocation', {
      meta: {
        id: next.id,
        type: next.type,
        providerId: next.providerId,
        mode: next.mode,
      },
    })
    // Persistence is best-effort fire-and-forget on the upsert path —
    // the service stays sync (the cap surface awaits provider methods,
    // not the orchestrator's own writes). Errors are surfaced to the
    // logger so an SQLite hiccup doesn't silently desync.
    if (this.locationStore) {
      const store = this.locationStore
      void (async () => {
        try {
          await store.upsert(next)
        } catch (err) {
          this.logger.error('storage-orchestrator: upsert persistence failed', {
            meta: {
              id: next.id,
              error: err instanceof Error ? err.message : String(err),
            },
          })
        }
      })()
    }
    return next
  }

  /**
   * Remove a location. Refuses the last location of a type and the last
   * enabled location of a type. `isSystem` is informational — a frozen
   * recordings `:default` is deletable once a sibling is live. Occupancy still
   * refuses unless `force` is set; force never overrides uniqueness /
   * last-enabled.
   */
  async deleteLocation(id: string, options?: DeleteLocationOptions): Promise<void> {
    const loc = this.locations.get(id)
    if (!loc) {
      throw new Error(`Storage location "${id}" not found`)
    }
    const ofType = [...this.locations.values()].filter((l) => l.type === loc.type)
    if (ofType.length <= 1) {
      throw new Error(`Cannot delete "${id}" — it is the only location for type "${loc.type}"`)
    }
    const enabledOfType = ofType.filter((l) => mayWriteToLocation(l))
    if (mayWriteToLocation(loc) && enabledOfType.length <= 1) {
      throw new Error(
        `Cannot delete "${id}" — it is the only enabled location for type "${loc.type}"`,
      )
    }
    // ── Occupancy ────────────────────────────────────────────────────────
    // Deleting a location that still holds data is how this hub acquired
    // 2 131 ghost `recordings:high` segments: the rows survive the record,
    // `collectRangeSegments` then drops every row naming a location it cannot
    // resolve, and playback — which does not stat — renders a silent black
    // window rather than an error. `unknown` refuses alongside `occupied`,
    // because a probe that could not reach the location has not established
    // that it is empty.
    const occupancy = await this.probeOccupancy(loc)
    if (occupancy !== 'empty') {
      if (options?.force !== true) {
        throw new Error(
          occupancy === 'occupied'
            ? `Storage location "${id}" still holds data — drain it first (storage migration / relocate), or pass force to delete the record anyway and strand what is on it`
            : `Storage location "${id}" could not be checked for remaining data (unreachable provider, another node, or an unmounted root) — pass force to delete the record anyway`,
        )
      }
      this.logger.warn(
        'storage-orchestrator: FORCED delete of a location that was not verified empty',
        { meta: { id, type: loc.type, occupancy } },
      )
    }
    this.locations.delete(id)
    if (this.locationStore) {
      const store = this.locationStore
      void store.delete(id).catch((err) => {
        this.logger.error('storage-orchestrator: delete persistence failed', {
          meta: { id, error: err instanceof Error ? err.message : String(err) },
        })
      })
    }
  }

  /**
   * Run the injected occupancy probe, converting "no probe" and "the probe
   * threw" into `unknown` rather than into a permit.
   */
  private async probeOccupancy(location: StorageLocation): Promise<LocationOccupancy> {
    const probe = this.occupancyProbe
    if (probe === null) return 'unknown'
    try {
      return await probe(location)
    } catch (err) {
      this.logger.warn('storage-orchestrator: occupancy probe failed', {
        meta: { id: location.id, error: err instanceof Error ? err.message : String(err) },
      })
      return 'unknown'
    }
  }

  /**
   * Remove seed-shaped locations (`<type>:default`) whose type is no longer
   * declared by any addon (stale defaults from a removed location type).
   * Operator-added locations of an undeclared type are KEPT but warned.
   *
   * FAIL-SAFE: if the registry is EMPTY (no addon declared any location), we
   * refuse to prune anything. An empty registry almost always means
   * declarations failed to load (boot ordering, a stale install) — pruning
   * "everything undeclared" in that state would wipe every seeded location
   * (data/logs/recordings/…). Better to keep stale rows than destroy live ones.
   */
  pruneUndeclaredSystemLocations(): void {
    if (!this.registry) return
    if (this.registry.list().length === 0) {
      this.logger.warn(
        'storage-orchestrator: skipping prune — no location declarations loaded (fail-safe)',
      )
      return
    }
    for (const [id, loc] of Array.from(this.locations)) {
      if (this.registry.cardinalityOf(loc.type) !== null) continue // still declared
      const seeded = loc.id === `${loc.type}:default`
      if (seeded) {
        this.locations.delete(id)
        if (this.locationStore) {
          const store = this.locationStore
          void store.delete(id).catch((err) => {
            this.logger.error('storage-orchestrator: prune persistence failed', {
              meta: {
                id,
                error: err instanceof Error ? err.message : String(err),
              },
            })
          })
        }
        this.logger.info('storage-orchestrator: pruned stale seeded location', {
          meta: { id, type: loc.type },
        })
      } else {
        this.logger.warn(
          'storage-orchestrator: location of undeclared type kept (operator-owned)',
          { meta: { id, type: loc.type } },
        )
      }
    }
  }

  // ── Ref resolution ────────────────────────────────────────────────────

  /**
   * Resolve a `StorageLocationRef` to a concrete `StorageLocation`.
   *  - bare type (e.g. `'backups'`) → default location of that type
   *  - fully-qualified id (e.g. `'backups:nas-01'`) → that exact instance
   *
   * Throws an actionable error when nothing matches — every consumer of
   * the singleton `storage` cap funnels through here, so the error
   * message is what operators see when the orchestrator's view of the
   * world doesn't match expectations.
   */
  resolveRef(ref: StorageLocationRef): StorageLocation {
    if (ref.includes(':')) {
      const loc = this.locations.get(ref)
      if (!loc) {
        throw new Error(`Storage location "${ref}" not found`)
      }
      return loc
    }
    // Bare-type form — any non-`:` string is a location type id now that types
    // are open (declaration-driven). With no default to consult (D383):
    //
    //   1. exactly one location of the type  → that one, unambiguously;
    //   2. several                           → the `<type>:default`-slugged
    //      row, TRANSITIONALLY and logged as deprecated. This is a lexical
    //      anchor, not a restored flag: every legacy row that stamped no
    //      `locationId` had its bytes written when that row was the write
    //      target, so a slug-anchored READ cannot be repointed out from under
    //      it by any later cutover. It is deleted once no unstamped row exists;
    //   3. neither                           → refuse, naming the candidates.
    //
    // Note this is a READ path: it deliberately does NOT filter by `enabled`.
    // A disabled location is read-only, not gone, and narrowing a read is the
    // worse bug (a black window instead of an error).
    const ofType = [...this.locations.values()].filter((loc) => loc.type === ref)
    if (ofType.length === 1) return ofType[0]!
    if (ofType.length === 0) {
      throw new Error(
        `No storage location configured for type "${ref}" — register one or pass a fully-qualified id (\`<type>:<slug>\`)`,
      )
    }
    const slugged = ofType.find((loc) => loc.id === `${ref}:default`)
    if (!slugged) {
      throw new Error(
        `Storage type "${ref}" has ${String(ofType.length)} locations (${ofType
          .map((loc) => loc.id)
          .toSorted()
          .join(
            ', ',
          )}) — a bare type ref is ambiguous, pass a fully-qualified id (\`<type>:<slug>\`)`,
      )
    }
    this.logger.warn(
      'storage-orchestrator: DEPRECATED bare-type ref on a type with several locations — ' +
        'resolved to the legacy `:default`-slugged row. Pass a fully-qualified location id.',
      { meta: { ref, resolved: slugged.id, candidates: ofType.length } },
    )
    return slugged
  }

  // ── Provider lookup ───────────────────────────────────────────────────

  /**
   * Find the storage-provider that backs a given location — the entry point
   * every consumer-facing `storage` cap method funnels through.
   *
   * Routing key is `(providerId, nodeId)`, never `providerId` alone: every
   * node's FilesystemStorageProvider registers under the SAME providerId, so
   * a providerId-only match resolves to whichever node asked. That is how a
   * location created on an agent ended up writing to the HUB's filesystem
   * (root-caused 2026-07-29).
   */
  async getProviderFor(location: StorageLocation): Promise<IStorageProviderImpl> {
    return this.getProviderForTarget(
      {
        providerId: location.providerId,
        ...(location.nodeId !== undefined && { nodeId: location.nodeId }),
      },
      `location "${location.id}"`,
      location.id,
    )
  }

  /**
   * Resolve one dispatch target to the provider that must execute it.
   *
   * `descriptor` is the operator-facing subject of the error message
   * (`location "recordings:disk"`, `uploadId "u-42"`); `locationId` is the
   * structured tag for the log line when there is a location behind the
   * dispatch (chunked sessions carry only the session id).
   *
   * Both failure branches LOG before throwing, and NEITHER falls back to the
   * local provider — a silent fallback is the bug this method exists to fix.
   */
  private async getProviderForTarget(
    target: StorageDispatchTarget,
    descriptor: string,
    locationId?: string,
  ): Promise<IStorageProviderImpl> {
    const nodeId = target.nodeId
    if (nodeId !== undefined && bareNodeId(nodeId) !== this.localNode) {
      const remote = this.getRemoteProvider?.(nodeId)
      if (remote) return remote
      this.logger.error(
        'storage-orchestrator: target node has no reachable storage-provider — dispatch refused',
        {
          meta: {
            ...(locationId !== undefined && { locationId }),
            descriptor,
            nodeId,
            providerId: target.providerId,
            localNodeId: this.localNode,
            crossNodeResolverWired: this.getRemoteProvider !== undefined,
          },
        },
      )
      throw new Error(
        `storage-provider for ${descriptor} lives on node "${nodeId}" which is not reachable`,
      )
    }
    const providers = this.getProviders()
    for (const p of providers) {
      const info = await p.getProviderInfo()
      if (info.providerId === target.providerId) return p
    }
    this.logger.error('storage-orchestrator: no local storage-provider for providerId', {
      meta: {
        ...(locationId !== undefined && { locationId }),
        descriptor,
        providerId: target.providerId,
        localNodeId: this.localNode,
        registered: providers.length,
      },
    })
    throw new Error(
      `No storage-provider registered for providerId "${target.providerId}" (${descriptor})`,
    )
  }

  // ── Chunked-session routing ───────────────────────────────────────────

  /**
   * Remember which provider — and on which NODE — opened a chunked session.
   * `beginUpload` / `beginDownload` carry a `StorageLocation`; every later
   * chunk carries only the session id, and a session id issued by an agent
   * means nothing to the hub's provider.
   */
  rememberSession(kind: StorageSessionKind, sessionId: string, location: StorageLocation): void {
    this.sessionTargets.set(sessionKey(kind, sessionId), {
      providerId: location.providerId,
      ...(location.nodeId !== undefined && { nodeId: location.nodeId }),
    })
  }

  /** Drop a session's routing entry (finalize / abort / end). */
  forgetSession(kind: StorageSessionKind, sessionId: string): void {
    this.sessionTargets.delete(sessionKey(kind, sessionId))
  }

  /** Drop every session entry (addon shutdown). */
  clearSessions(): void {
    this.sessionTargets.clear()
  }

  /**
   * Resolve the provider that owns an in-flight chunked session, on the node
   * that opened it. Throws when the orchestrator has no record of the open
   * call (provider gone, or a chunk for a session it never issued).
   */
  async getProviderForSession(
    kind: StorageSessionKind,
    sessionId: string,
  ): Promise<IStorageProviderImpl> {
    const vocabulary = SESSION_VOCABULARY[kind]
    const descriptor = `${vocabulary.idLabel} "${sessionId}"`
    const target = this.sessionTargets.get(sessionKey(kind, sessionId))
    if (!target) {
      this.logger.error('storage-orchestrator: chunk for an unknown session — dispatch refused', {
        meta: { descriptor, kind, sessionId },
      })
      throw new Error(
        `Unknown ${vocabulary.idLabel} "${sessionId}" — orchestrator has no record of ${vocabulary.openMethod}`,
      )
    }
    return this.getProviderForTarget(target, descriptor)
  }

  /** Convenience: lookup by id (returns `undefined` if not found). */
  getLocationById(id: string): StorageLocation | undefined {
    return this.locations.get(id)
  }

  // ── First-boot seeding (declaration-driven) ───────────────────────────

  /**
   * Seed one default `StorageLocation` per addon-declared location that
   * doesn't already have one. Idempotent — re-running with the same
   * declarations on a populated map is a no-op (each declared `id`
   * already resolves to an existing `<id>:default`).
   *
   * The seeded row is born ENABLED — a fresh install must be able to write the
   * moment it boots, and `enabled` is the only write switch there is (D383).
   * The `:default` suffix is a NAME kept for idempotency across existing
   * installs, not a flag: the stored `id` is `'recordings:default'` so it
   * satisfies the
   * `^[a-z][a-z0-9-]*:[a-z0-9-]+$` regex on `StorageLocationSchema.id`.
   *
   * `basePath` is the storage root (e.g. `<CAMSTACK_DATA>`). Each
   * location's `config.basePath` is `<basePath>/<id>`, except when the
   * declaration sets `defaultsTo` — then it inherits the resolved root of
   * the referenced location's default instance (sharing the same root
   * directory for derivative slots like `recordingsLow` → `recordings`).
   */
  seedDefaults(input: {
    readonly providerId: string
    readonly basePath: string
    /**
     * Root for declarations marked `defaultRoot: 'media'` (the dedicated media
     * volume, `CAMSTACK_MEDIA_ROOT`). Absent → media declarations fall back to
     * `basePath` like everything else.
     */
    readonly mediaBasePath?: string
    /**
     * Root for declarations marked `defaultRoot: 'backup'` (the dedicated
     * backup volume, `CAMSTACK_BACKUP_ROOT`, default `/backups`). Absent →
     * backup declarations fall back to `basePath`.
     */
    readonly backupBasePath?: string
    readonly declarations: readonly StorageLocationDeclaration[]
  }): SeedOutcome {
    // A seed never runs while the store it seeds is not authoritative: no
    // answered read means "not yet known", never "there is no location".
    if (this.storeRequiredForSeed && this.locationStore === null) {
      this.logger.warn(
        'storage-orchestrator: seed deferred — the location store has not answered a read yet ' +
          '(not wired, adoption pending, or the read failed); seeding now could shadow the ' +
          "operator's existing locations",
      )
      return { added: 0, deferred: 'store-not-answered' }
    }
    let added = 0
    let deferredProvider = false
    const declById = new Map(input.declarations.map((d) => [d.id, d]))
    // Per-declaration seed root: `media`-rooted declarations land on
    // `mediaBasePath`, `backup`-rooted on `backupBasePath`, everything else on
    // `basePath` (each falling back to `basePath` when the dedicated root is
    // unset).
    const rootFor = (d: StorageLocationDeclaration): string => {
      const dedicated =
        d.defaultRoot === 'media'
          ? input.mediaBasePath
          : d.defaultRoot === 'backup'
            ? input.backupBasePath
            : undefined
      return path.join(dedicated ?? input.basePath, d.id)
    }
    for (const d of input.declarations) {
      // Skip ids already covered — first wins / idempotent re-seed.
      if (this.hasAnyLocationOfType(d.id)) {
        this.rememberSeeded(d.id)
        continue
      }
      // The operator removed it (or an older install never had it): a type that
      // was seeded once is never seeded again for having zero rows.
      if (this.seededTypes?.has(d.id)) continue
      if (this.installPredatesSeedMemory) {
        this.logger.info(
          'storage-orchestrator: existing install — not re-creating a default the operator may have removed',
          { meta: { type: d.id } },
        )
        this.rememberSeeded(d.id)
        continue
      }
      // A row born before its provider is classified carries no node pin; the
      // normal path (`upsertLocation`) stamps one. Wait for the classification
      // so a seeded row has the same shape as a created one.
      if (
        this.nodeLocalResolver !== null &&
        this.nodeLocalResolver(input.providerId) === undefined
      ) {
        deferredProvider = true
        continue
      }
      const base = d.defaultsTo
        ? ((this.getLocationById(`${d.defaultsTo}:default`)?.config['basePath'] as
            | string
            | undefined) ?? rootFor(declById.get(d.defaultsTo) ?? d))
        : rootFor(d)
      this.upsertLocation({
        id: `${d.id}:default`,
        type: d.id,
        displayName: d.displayName,
        providerId: input.providerId,
        config: { basePath: base },
        enabled: true,
        isSystem: false,
      })
      this.rememberSeeded(d.id)
      added++
    }
    if (added > 0) {
      this.logger.info('storage-orchestrator: seeded default locations', {
        meta: { added, basePath: input.basePath },
      })
    }
    if (deferredProvider) {
      this.logger.info(
        'storage-orchestrator: seed deferred for some types — provider not classified yet',
        { meta: { providerId: input.providerId } },
      )
    }
    return deferredProvider ? { added, deferred: 'provider-unclassified' } : { added }
  }

  /**
   * The same-type physical-root refusal (D389).
   *
   * An unresolvable root — another node's disk, a remote provider, a path that
   * does not exist yet — WARNS and lets the write through. Refusing on a read
   * that could not be taken blocks the operator on a doubt, and the recorder's
   * demotion still catches what slips past (D49's spirit).
   */
  private refuseSameTypeRootCollision(
    input: Omit<StorageLocation, 'createdAt' | 'updatedAt'>,
    existing: StorageLocation | undefined,
  ): void {
    const verdict = findRootCollision(input, this.locations.values(), this.resolveRoot, existing)
    if (verdict.outcome === 'clear') return
    if (verdict.outcome === 'unknown') {
      this.logger.warn(
        'storage-orchestrator: could not check this location for a same-type root collision — ' +
          'saving it anyway. A read that fails is not a refusal; the recorder demotes a ' +
          'same-root duplicate it later finds.',
        { meta: { id: input.id, type: input.type, ...verdict.unknown } },
      )
      return
    }
    throw new Error(rootCollisionMessage(input.id, verdict.collision))
  }

  /** Injectable so a test can drive symlinks and unresolvable paths without
   *  touching a real filesystem. Production takes the shared derivation. */
  private resolveRoot: ResolveRoot = (basePath) => physicalRootOf(basePath)

  /** Test seam for {@link refuseSameTypeRootCollision}. */
  setRootResolver(resolveRoot: ResolveRoot): void {
    this.resolveRoot = resolveRoot
  }

  /** Internal: check whether any location of the given type exists. */
  private hasAnyLocationOfType(type: string): boolean {
    for (const loc of this.locations.values()) {
      if (loc.type === type) return true
    }
    return false
  }
}

/**
 * Resolve the MODE one upsert lands on (D385). Pure: every input it needs is a
 * parameter. Ordered rules:
 *
 *   1. An explicit `mode` always wins — the operator named the state.
 *   2. An explicit `enabled` (the retired switch, still on the wire for one
 *      release) means `active` / `readonly`. It can never select `drain` or
 *      `disabled`: those are states only the new field can ask for, so an old
 *      client cannot start erasing a disk or hide footage by accident.
 *   3. On an UPDATE, an omitted state preserves what is stored — a rename or a
 *      path edit must never flip a live write target, and must never cancel a
 *      drain in progress.
 *   4. On a CREATE, an omitted state is `readonly` — creating a disk must not
 *      start writing to it — UNLESS it is the FIRST location of its type, where
 *      there is nothing else that could serve.
 */
function resolveUpsertMode(
  input: Omit<StorageLocation, 'createdAt' | 'updatedAt'>,
  existing: StorageLocation | undefined,
  typeAlreadyHasLocation: boolean,
): StorageLocationMode {
  // A caller that round-trips a whole row and flips `enabled` sends a pair that
  // DISAGREES — `mode: 'active', enabled: false`. The half that differs from
  // the derived mirror is the half the caller changed, so it is the half that
  // wins. Taking `mode` unconditionally would silently ignore every `enabled`
  // toggle sent by a client that has not moved to the new field yet.
  if (input.mode !== undefined) {
    if (input.enabled === undefined || input.enabled === modeMayWrite(input.mode)) return input.mode
  }
  if (input.enabled !== undefined) return input.enabled ? 'active' : 'readonly'
  if (existing) return resolveLocationMode(existing)
  return typeAlreadyHasLocation ? 'readonly' : 'active'
}

/** Types that may have zero enabled locations. Backups with none is sad, not illegal. */
const OPTIONAL_WRITE_TYPES = new Set(['backups'])

/**
 * Refuse an UPDATE that would leave a write-serving type with no enabled
 * location. Creates are exempt (an explicit `enabled: false` on the first
 * location is already a named test). Enabled IS the write set.
 */
function refuseLastWriteTargetDisabled(
  existing: StorageLocation | undefined,
  next: StorageLocation,
  locations: Iterable<StorageLocation>,
): void {
  if (OPTIONAL_WRITE_TYPES.has(next.type)) return
  if (mayWriteToLocation(next)) return
  if (existing === undefined) return
  if (!mayWriteToLocation(existing)) return
  for (const loc of locations) {
    if (loc.id === next.id || loc.type !== next.type) continue
    if (mayWriteToLocation(loc)) return
  }
  throw new Error(
    `Cannot disable "${next.id}": it is the last enabled location of type "${next.type}". ` +
      `Enable another location of this type first.`,
  )
}

/**
 * The same refusal, judged on a whole COMMIT rather than one row: a
 * multi-location change (a cutover enables its destination and disables its
 * source in one go) must be weighed on its RESULT, or the disable half looks
 * like the last write target leaving while the enable half is already in the
 * same map.
 */
function refuseTypeWithoutWriteTarget(
  touched: Iterable<StorageLocation>,
  result: Iterable<StorageLocation>,
): void {
  const rows = [...result]
  for (const type of new Set([...touched].map((loc) => loc.type))) {
    if (OPTIONAL_WRITE_TYPES.has(type)) continue
    const ofType = rows.filter((loc) => loc.type === type)
    if (ofType.length === 0) continue
    if (ofType.some((loc) => isLocationEnabled(loc))) continue
    throw new Error(
      `Refusing the write-set change: it would leave type "${type}" with no enabled location. ` +
        `Enable one of ${ofType
          .map((loc) => loc.id)
          .toSorted()
          .join(', ')} first.`,
    )
  }
}
