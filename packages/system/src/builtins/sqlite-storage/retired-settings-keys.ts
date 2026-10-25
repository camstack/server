/**
 * Retired settings keys — the boot-time purge of DEAD configuration.
 *
 * ## Why this exists
 *
 * When a feature is removed, its persisted keys stay in the store. Nothing
 * reads them, so nothing breaks — and that is exactly the problem: a dead key
 * still LOOKS like live configuration. On 2026-08-07 an audit read
 * `object-detection: yolo26m-256` out of `detection-pipeline`'s `pipelineSteps`
 * blob — a global step seed removed months earlier, that no live per-camera
 * dispatch has ever consulted — and spent an hour investigating a package-zone
 * fault against a model the node was not running.
 *
 * The fix is not a hand `DELETE`. A hand delete cleans one machine once: the
 * next boot of that node, and every restore of a backup taken before it, brings
 * the keys back. This purge runs at every boot of the settings engine ON THE
 * HUB, so the store CONVERGES no matter how it got there.
 *
 * ## Where it runs: the hub, and only the hub
 *
 * The addon settings store is hub-central. `settings-store` is a `singleton`
 * cap that resolves to the hub, so every node's `ctx.settings` reads and writes
 * the HUB's rows — an agent's own SQLite file holds node-local collections only
 * (`platform-probe`, `metrics-native`, `hub-forwarder`). Measured 2026-08-07:
 * neither agent even has a `detection-pipeline:addon-settings` table.
 *
 * So there is exactly one copy of the data to clean, and running the machinery
 * on every node's boot would be work that can never find anything. The gate is
 * {@link settingsStoreIsAuthoritativeHere}, and an agent skips SILENTLY — a
 * "skipped" line on every agent boot forever is noise about work that has no
 * reason to happen there.
 *
 * ## Contract
 *
 * - **Idempotent.** A clean row plans nothing, writes nothing, logs nothing.
 * - **Loud exactly once**, and only when it actually deletes: one line naming
 *   the addon, the row and the keys.
 * - **Exact-match only.** A retired key never prefix- or substring-matches, so
 *   the live `videoPipelineSteps` survives the retirement of `pipelineSteps`.
 *   `perNodeKeys` additionally match the `<key>@<nodeId>` form the per-node
 *   store writes (`nodeScopedKey`), and nothing else.
 * - **A failed read never writes.** Same rule as `settings-read-guard.ts`: a
 *   read fault answering "empty" would rewrite the row to `{}` and destroy the
 *   live keys the purge exists to protect.
 *
 * ## Adding a key
 *
 * Only add a key you have TRACED to having no reader. The registry is a claim
 * that the key is dead; it is enforced by nothing else.
 */

import type { ISettingsBackend, SettingsCollection } from '@camstack/types'
import { asJsonObject } from '@camstack/types/addon'

/** One retired-key declaration, scoped to a single store row. */
export interface RetiredKeySpec {
  /** Addon id owning the store (the settings-store namespace). */
  readonly namespace: string
  /** Collection inside that namespace, e.g. `addon-settings`. */
  readonly collection: SettingsCollection
  /** Row id inside the collection, e.g. `root`. */
  readonly row: string
  /** Keys retired verbatim. Matched exactly. */
  readonly keys: readonly string[]
  /**
   * Keys retired in both their bare form and their per-node form
   * (`<key>@<nodeId>`), which is how `nodeScopedKey` persists a
   * `perNode: true` schema field.
   */
  readonly perNodeKeys: readonly string[]
  /**
   * Keys retired one level DOWN, inside each object value of a map-shaped row.
   *
   * `device-manager`'s `deviceMeta` row is `{ [deviceId]: PersistedDeviceMeta }`:
   * the dead key is not a key of the row, it is a key of each device's meta.
   * Absent ⇒ the row is treated as flat and nothing nested is touched.
   */
  readonly mapValueKeys?: readonly string[]
  /** Why they are dead — cited in the record, not re-derived at the call site. */
  readonly reason: string
}

/** What a purge pass deleted from one row. */
export interface RetiredKeyPurgeResult {
  readonly addon: string
  readonly collection: string
  readonly row: string
  readonly keys: readonly string[]
  /** `<mapKey>.<retiredKey>` for every nested deletion. Empty for a flat row. */
  readonly nested: readonly string[]
}

/** The store access the purge needs. Narrow on purpose — trivially fakeable. */
export interface RetiredKeyStore {
  /** Current row value, or `null` when the row does not exist. Throws on fault. */
  read(spec: RetiredKeySpec): Promise<Record<string, unknown> | null>
  /** Replace the row with `value`. */
  write(spec: RetiredKeySpec, value: Record<string, unknown>): Promise<void>
}

/**
 * The store access the ROW purge needs. Separate from {@link RetiredKeyStore}
 * because it has a different owner: a retired row is purged by the ADDON that
 * stopped writing it, right after it has declared the successor collection —
 * not by the settings engine at its own boot, which runs before any addon has
 * declared anything and would find every successor unreadable, forever.
 */
export interface RetiredRowStore {
  /** Does the row exist at all? Throws on fault. */
  hasRow(spec: RetiredRowSpec): Promise<boolean>
  /** Delete the row outright. Idempotent. */
  deleteRow(spec: RetiredRowSpec): Promise<void>
  /** How many rows the evidence collection holds. Throws on fault. */
  countRows(collection: SettingsCollection): Promise<number>
}

/** What a row purge deleted. */
export interface RetiredRowPurgeResult {
  readonly owner: string
  readonly collection: string
  readonly row: string
}

/**
 * Is THIS node the one whose settings store is the cluster's authority?
 *
 * Mirrors `resolveNodeRole` (server/backend `node-role.ts`) — unset or `'hub'`
 * means hub, which is the launcher's own default. It is duplicated rather than
 * imported because `@camstack/system` is a dependency OF the backend, not the
 * other way round; the parse is four lines and the env var is the contract.
 *
 * Anything else answers `false`. Skipping where the purge should have run is a
 * missed cleanup the next hub boot fixes; running where it should not have is a
 * write to a store this node does not own. Only one of those is recoverable.
 */
export function settingsStoreIsAuthoritativeHere(env: NodeJS.ProcessEnv): boolean {
  const raw = (env['CAMSTACK_ROLE'] ?? '').trim().toLowerCase()
  return raw === '' || raw === 'hub'
}

/** The logging surface the purge uses — a structural subset of `IScopedLogger`. */
export interface RetiredKeyLogger {
  info(message: string, context?: { readonly meta?: Record<string, unknown> }): void
  warn(message: string, context?: { readonly meta?: Record<string, unknown> }): void
}

/**
 * The dead keys, per row.
 *
 * ## Addressing these rows
 *
 * Every namespace below is a FORKED addon, whose `ctx.settings` comes from
 * `addon-context-factory` and writes `<addonId>:addon-settings` row `root`. The
 * scoped table is therefore the right target — unlike the hub builtin whose
 * mis-addressed spec is dissected at {@link RetiredRowSpec}. Confirmed per
 * namespace against `packages/<pkg>/package.json`'s manifest `id`.
 *
 * ## `keys` vs `perNodeKeys` is a data-loss decision, not a style choice
 *
 * `perNodeKeys` matches `<key>` AND `<key>@<nodeId>`. That is right for a key
 * whose per-node copies are all dead (the engine cascade, the decoder
 * `backend`). It is WRONG for `probedBestHwaccel` / `probedBestAudioBackend`,
 * where the bare key is unreachable residue but every `@<nodeId>` copy is the
 * node's live probe result — those go under `keys`, which is exact-match.
 *
 * `detection-pipeline` / `addon-settings` / `root` — every key in this row is
 * dead; the row itself is kept because the addon writes a live key into it
 * (`videoPipelineSteps`). `pipelineTemplates` is no longer read or written
 * (templates were removed, D759) and is deliberately NOT listed here: stored
 * template rows are left exactly as they are.
 *
 *  - `pipelineSteps` / `pipelineEngine`: the persisted GLOBAL step + engine
 *    seed. Removed with `getGlobalSteps` becoming pure — dispatch builds steps
 *    from the orchestrator's `agentSettings` plus per-camera overrides, and
 *    never consulted the seed. See `addon-pipeline/src/detection-pipeline/provider.ts`.
 *  - `engineRuntime` / `engineBackend` / `engineDevice` / `probedBestEngine`:
 *    the per-node engine CASCADE, removed with the operator-facing engine
 *    election. Each node now runs a device-array of inference pools balanced
 *    per session, and the node-default pool derives live from the node's own
 *    hardware (`resolveAutoEngine`). See
 *    `addon-pipeline/src/detection-pipeline/engine-store-keys.ts`.
 */
export const RETIRED_SETTINGS_KEYS: readonly RetiredKeySpec[] = [
  {
    namespace: 'detection-pipeline',
    collection: 'addon-settings',
    row: 'root',
    keys: ['pipelineSteps', 'pipelineEngine'],
    perNodeKeys: ['engineRuntime', 'engineBackend', 'engineDevice', 'probedBestEngine'],
    reason:
      'global step/engine seed and the per-node engine cascade — both removed; ' +
      'the live per-camera dispatch path never read either',
  },
  {
    namespace: 'pipeline-orchestrator',
    collection: 'addon-settings',
    row: 'root',
    keys: [
      'enabledNodes',
      'enabledDecoderNodes',
      'enabledAudioNodes',
      'remoteSourcingNodes',
      'nativeLeaseTtlMs',
    ],
    // `backend` is per-node (`backend@<nodeId>`) AND may exist bare on a hub
    // that predates `scopeDecoderPatch`. Both forms go: no reader survives
    // for either, and `resolveDecoderBackend` ignores the store outright.
    perNodeKeys: ['backend'],
    reason:
      'the pre-singleton "enabled nodes" role model (node capability now lives per ' +
      'node in agent-settings and is derived by NodeTopology.refresh, never read from ' +
      'this row), `nativeLeaseTtlMs` superseded by `nativeLeaseActivityMs`, and the ' +
      'decoder `backend` selector whose resolver returns DEFAULT_DECODER_BACKEND ' +
      'unconditionally (decoder-backend.ts)',
  },
  {
    namespace: 'stream-broker',
    collection: 'addon-settings',
    row: 'root',
    keys: ['maxDecodeFps', 'initialReconnectDelayMs', 'maxReconnectDelayMs'],
    perNodeKeys: [],
    reason:
      'three form knobs deleted 2026-08-28 (D272): nothing capped decode fps, and the ' +
      'reconnect ladder has always run on the INITIAL/MAX_RECONNECT_DELAY_MS constants',
  },
  {
    namespace: 'embedding-encoder',
    collection: 'addon-settings',
    row: 'root',
    // Exact-match only. `backend` here is a FLAT key of this addon's row and
    // has nothing to do with the orchestrator's per-node decoder `backend`.
    keys: ['runtime', 'backend'],
    perNodeKeys: [],
    reason:
      'two selects deleted 2026-08-28 (D272); their only reference was a withTags log ' +
      'field, and the CUDA/CoreML options named acceleration that has never existed — ' +
      'embedding inference is always ONNX in the embedded Python',
  },
  {
    namespace: 'audio-analyzer',
    collection: 'addon-settings',
    row: 'root',
    // `probedBestAudioBackend` is EXACT-match: the live per-node copies are
    // `probedBestAudioBackend@<nodeId>` and MUST survive. Listing it under
    // `perNodeKeys` would take every node's probe result with it.
    keys: ['selectedAudioModel', 'probedBestAudioBackend'],
    perNodeKeys: [],
    reason:
      '`selectedAudioModel` deleted 2026-08-28 (D272) — createAudioPipeline takes a ' +
      'backend and no model id, so it never reached inference; the BARE ' +
      '`probedBestAudioBackend` is pre-perNode residue that projectStore already drops ' +
      '(no bare fallback), so no node can ever read it',
  },
  {
    namespace: 'decoder-nodeav',
    collection: 'addon-settings',
    row: 'root',
    // Same exact-match reasoning as `probedBestAudioBackend` above: the live
    // value is `probedBestHwaccel@<nodeId>`, and only the bare key is dead.
    keys: ['probedBestHwaccel'],
    perNodeKeys: [],
    reason:
      'bare pre-perNode residue — the live probe result is `probedBestHwaccel@<nodeId>` ' +
      'and `projectStore` deliberately drops the bare key, so nothing can read it',
  },
  {
    namespace: 'pipeline-analytics',
    collection: 'addon-settings',
    row: 'root',
    keys: ['mediaAttachPolicy'],
    perNodeKeys: [],
    reason:
      'deleted 2026-08-28 (D272) — absent from MediaSettingsSchema, so the value was ' +
      'never even resolved, let alone read',
  },
  {
    namespace: 'waste-collections',
    collection: 'addon-settings',
    row: 'root',
    keys: ['fetchHour'],
    perNodeKeys: [],
    reason:
      'deleted 2026-10-24 — the "daily fetch hour" was never honoured: sources refresh at ' +
      'boot and every 24 h from then, and nothing ever read the value back (D268)',
  },
]

/**
 * Whole ROWS whose owner stopped writing them.
 *
 * A key purge cannot express this. It reads a row, drops keys, writes the rest
 * back — so retiring everything in a row leaves an empty row behind, and
 * retiring a row that IS a map of devices would mean listing 974 keys. What is
 * dead here is the row itself.
 *
 * ### Addressing: these rows are NOT namespaced
 *
 * `namespace` on a {@link RetiredKeySpec} is the settings-store namespace, and
 * it resolves to the table `<namespace>:<collection>`. That is right for an
 * addon whose `ctx.settings` came from `addon-context-factory` (a forked
 * runner), which writes `<addonId>:addon-settings` row `root`. A HUB BUILTIN
 * does not: its `ctx.settings` comes from `ConfigManager.createSettingsView`,
 * which is `getAllAddon` / `setAllAddon` — one row per key in the UNSCOPED
 * `addon-settings` table, keyed `<addonId>.<key>`.
 *
 * The device-manager is a hub builtin, so its rows are
 * `addon-settings` / `device-manager.deviceMeta` and never lived in
 * `device-manager:addon-settings`. The previous key-spec pointed at the scoped
 * table and was therefore a no-op on every hub that ever ran it — measured on
 * the 2026-08-19 evidence copy: `device-manager:addon-settings` has zero rows,
 * while `addon-settings` holds all six device-manager keys.
 *
 * ### Ordering: the guard is not optional
 *
 * These rows are the ONLY copy of the fleet until
 * `scripts/migrate-device-manager-blobs.mjs` has written
 * `device-manager:devices`. Purging them on a hub that has not been migrated
 * destroys every device. {@link purgeRetiredSettingsRows} therefore refuses
 * unless `evidence` — a collection that must be non-empty — actually is.
 */
export interface RetiredRowSpec {
  /** Settings-store namespace, or absent for an unscoped collection. */
  readonly namespace?: string
  readonly collection: SettingsCollection
  /** Row id inside that collection. */
  readonly row: string
  /** Addon that owned the row — reported, never used to address it. */
  readonly owner: string
  /**
   * A collection that must hold at least one row before this one may go.
   * The successor of the retired data: if it is empty, the migration has not
   * run here and deleting is data loss, not cleanup.
   */
  readonly evidence: { readonly collection: SettingsCollection }
  readonly reason: string
}

/**
 * The device-manager's three fleet blobs, replaced by one row per device in
 * `device-manager:devices` (`device-row-store.ts`).
 *
 * 625 KB of the `addon-settings` table's 627 KB, re-read and re-parsed on every
 * projection and rewritten in full on every rename. `deviceIndex` is listed
 * here like the other two even though it was never migrated: `addonId` and
 * `stableId` are columns of every row, so an addon's device list is a query,
 * and the one bit that was not derivable — "has `registerDevice` run?" — is the
 * `registered` column.
 */
export const RETIRED_SETTINGS_ROWS: readonly RetiredRowSpec[] = [
  {
    collection: 'addon-settings',
    row: 'device-manager.deviceMeta',
    owner: 'device-manager',
    evidence: { collection: 'device-manager:devices' },
    reason:
      'the fleet is one row per device in `device-manager:devices` since the flatten; ' +
      'this blob was 467 KB read and JSON.parsed on hub-main per projection',
  },
  {
    collection: 'addon-settings',
    row: 'device-manager.deviceMetadata',
    owner: 'device-manager',
    evidence: { collection: 'device-manager:devices' },
    reason:
      'hardware-identity metadata is the `metadata` column of the device row; the ' +
      'separate blob existed only because a blob write is whole-value',
  },
  {
    collection: 'addon-settings',
    row: 'device-manager.deviceIndex',
    owner: 'device-manager',
    evidence: { collection: 'device-manager:devices' },
    reason:
      'derivable: `addonId`/`stableId` are indexed columns, and index membership ' +
      'is the `registered` column',
  },
]

/**
 * Adapt the settings backend to {@link RetiredKeyStore}.
 *
 * `get` answering a non-object (missing row) is a MISS, not a fault: it maps to
 * `null` and the purge skips the row. A backend throw propagates, which is what
 * routes it to the "read failed, row left untouched" branch.
 */
export function retiredKeyStoreOf(backend: ISettingsBackend): RetiredKeyStore {
  return {
    async read(spec) {
      const raw = await backend.get({
        namespace: spec.namespace,
        collection: spec.collection,
        key: spec.row,
      })
      return asJsonObject(raw)
    },
    async write(spec, value) {
      await backend.set({
        namespace: spec.namespace,
        collection: spec.collection,
        key: spec.row,
        value,
      })
    },
  }
}

/**
 * Nested `<mapKey>.<retiredKey>` paths that `spec` retires inside a map-shaped
 * row. Pure. Values that are not plain objects are skipped, never rewritten.
 */
export function planNestedRetiredKeyPurge(
  blob: Readonly<Record<string, unknown>>,
  spec: RetiredKeySpec,
): readonly string[] {
  const nestedKeys = spec.mapValueKeys ?? []
  if (nestedKeys.length === 0) return []
  const found: string[] = []
  for (const [mapKey, value] of Object.entries(blob)) {
    const inner = asJsonObject(value)
    if (inner === null) continue
    for (const retired of nestedKeys) {
      if (retired in inner) found.push(`${mapKey}.${retired}`)
    }
  }
  return found
}

/** Keys of `blob` that `spec` retires. Pure. */
export function planRetiredKeyPurge(
  blob: Readonly<Record<string, unknown>>,
  spec: RetiredKeySpec,
): readonly string[] {
  const exact = new Set(spec.keys)
  const found: string[] = []
  for (const key of Object.keys(blob)) {
    if (exact.has(key)) {
      found.push(key)
      continue
    }
    for (const perNode of spec.perNodeKeys) {
      if (key === perNode || key.startsWith(`${perNode}@`)) {
        found.push(key)
        break
      }
    }
  }
  return found
}

/**
 * Delete every retired key present in the declared rows — on the hub.
 *
 * Off the authoritative node this is a no-op that touches nothing and says
 * nothing (see the module header). Returns one entry per row that actually
 * changed — empty when the store is already clean, which is the steady state
 * after the first boot that ran it.
 */
export async function purgeRetiredSettingsKeys(
  store: RetiredKeyStore,
  logger: RetiredKeyLogger,
  specs: readonly RetiredKeySpec[] = RETIRED_SETTINGS_KEYS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly RetiredKeyPurgeResult[]> {
  if (!settingsStoreIsAuthoritativeHere(env)) return []

  const results: RetiredKeyPurgeResult[] = []

  for (const spec of specs) {
    let blob: Record<string, unknown> | null
    try {
      blob = await store.read(spec)
    } catch (err) {
      // A read fault is NOT an empty row. Writing here would replace live
      // configuration with the purge's idea of "everything that was left",
      // which is nothing. Skip the row; the next boot retries.
      logger.warn('retired settings keys — read failed, row left untouched', {
        meta: {
          addon: spec.namespace,
          collection: spec.collection,
          row: spec.row,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      continue
    }
    if (blob === null) continue

    const doomed = planRetiredKeyPurge(blob, spec)
    const doomedNested = planNestedRetiredKeyPurge(blob, spec)
    if (doomed.length === 0 && doomedNested.length === 0) continue

    const doomedSet = new Set(doomed)
    const nestedByMapKey = new Map<string, Set<string>>()
    for (const path of doomedNested) {
      const cut = path.indexOf('.')
      const mapKey = path.slice(0, cut)
      const inner = path.slice(cut + 1)
      const bucket = nestedByMapKey.get(mapKey) ?? new Set<string>()
      bucket.add(inner)
      nestedByMapKey.set(mapKey, bucket)
    }
    const next = Object.fromEntries(
      Object.entries(blob)
        .filter(([key]) => !doomedSet.has(key))
        .map(([key, value]) => {
          const retired = nestedByMapKey.get(key)
          if (retired === undefined) return [key, value]
          const inner = asJsonObject(value)
          if (inner === null) return [key, value]
          return [key, Object.fromEntries(Object.entries(inner).filter(([k]) => !retired.has(k)))]
        }),
    )
    await store.write(spec, next)

    const result: RetiredKeyPurgeResult = {
      addon: spec.namespace,
      collection: spec.collection,
      row: spec.row,
      keys: doomed,
      nested: doomedNested,
    }
    results.push(result)
    logger.info(`purged ${doomed.length + doomedNested.length} retired settings keys`, {
      meta: { ...result, reason: spec.reason },
    })
  }

  return results
}

/**
 * Delete every retired ROW whose successor is populated — on the hub.
 *
 * Off the authoritative node this is a no-op that touches nothing and says
 * nothing, same gate as {@link purgeRetiredSettingsKeys}.
 *
 * **The evidence check is the whole safety of this function.** A retired row is
 * the only copy of its data until the migration has written the successor
 * collection, and the migration is an OFFLINE step an operator runs — it is not
 * part of boot. So a hub that boots the new code before being migrated must
 * find its blobs intact, not deleted: the purge SKIPS, loudly, and the next
 * boot after the migration cleans up. An evidence read that FAILS is treated
 * exactly like an empty one — a fault is never permission to delete.
 */
export async function purgeRetiredSettingsRows(
  store: RetiredRowStore,
  logger: RetiredKeyLogger,
  specs: readonly RetiredRowSpec[] = RETIRED_SETTINGS_ROWS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly RetiredRowPurgeResult[]> {
  if (!settingsStoreIsAuthoritativeHere(env)) return []

  const results: RetiredRowPurgeResult[] = []
  /** Evidence counts, memoised per collection — the specs share successors. */
  const evidence = new Map<string, number>()

  for (const spec of specs) {
    let present: boolean
    try {
      present = await store.hasRow(spec)
    } catch (err) {
      logger.warn('retired settings row — read failed, row left untouched', {
        meta: {
          addon: spec.owner,
          collection: spec.collection,
          row: spec.row,
          error: errText(err),
        },
      })
      continue
    }
    if (!present) continue

    const successor = spec.evidence.collection
    let count = evidence.get(successor)
    if (count === undefined) {
      try {
        count = await store.countRows(successor)
      } catch (err) {
        // A fault is not evidence. Skipping costs one more boot with a dead
        // row; deleting costs the fleet.
        logger.warn('retired settings row — successor unreadable, row left untouched', {
          meta: { addon: spec.owner, row: spec.row, successor, error: errText(err) },
        })
        count = 0
      }
      evidence.set(successor, count)
    }
    if (count === 0) {
      logger.warn('retired settings row kept — its successor is empty, migration has not run', {
        meta: { addon: spec.owner, collection: spec.collection, row: spec.row, successor },
      })
      continue
    }

    await store.deleteRow(spec)
    const result: RetiredRowPurgeResult = {
      owner: spec.owner,
      collection: spec.collection,
      row: spec.row,
    }
    results.push(result)
    logger.info('purged a retired settings row', { meta: { ...result, reason: spec.reason } })
  }

  return results
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
