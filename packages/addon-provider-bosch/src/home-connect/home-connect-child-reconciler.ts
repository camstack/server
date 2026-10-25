import { errMsg, type IScopedLogger } from '@camstack/types'
import {
  deriveChildBindings,
  HomeConnectChildBindingSchema,
  isDerivedSuffix,
  legacyChildBindings,
  withCurrentLegacyKey,
  type HomeConnectChildBinding,
} from './home-connect-child-bindings.js'
import type { HomeConnectDescriptionStore } from './home-connect-description-store.js'
import type { HomeConnectWatchEvent } from './home-connect-gateway.js'
import {
  HOME_CONNECT_INFO_PREFIX,
  HOME_CONNECT_NETWORK_PREFIX,
  type HomeConnectWsClient,
} from './home-connect-ws-client.js'

/** Quiet time after the last change before the children are re-derived. */
export const HOME_CONNECT_RECONCILE_DEBOUNCE_MS = 3_000

export interface TrackedAppliance {
  readonly deviceId: number
  readonly brokerId: string
  readonly haId: string
}

export interface HomeConnectChildReconcilerDeps {
  readonly watch: (
    integrationId: string,
    haId: string,
    listener: (event: HomeConnectWatchEvent) => void,
  ) => () => void
  readonly getClient: (integrationId: string) => HomeConnectWsClient | null
  /** Re-derive the container's children from this `entities` list (rebuilds it only when it changed). */
  readonly applyEntities: (
    deviceId: number,
    entities: readonly HomeConnectChildBinding[],
  ) => Promise<void>
  /** The container's CURRENT persisted bindings (read fresh: a rebuild may have changed them). */
  readonly readPersisted: (deviceId: number) => Promise<{
    readonly bindings: readonly HomeConnectChildBinding[]
    readonly malformed: number
  }>
  readonly logger: IScopedLogger
  readonly debounceMs?: number
}

function isSyntheticKey(key: string): boolean {
  return key.startsWith(HOME_CONNECT_INFO_PREFIX) || key.startsWith(HOME_CONNECT_NETWORK_PREFIX)
}

/** Keys of persisted children the description does not list (info / network keys never count). */
export function keysMissingFromDescription(
  persisted: readonly HomeConnectChildBinding[],
  description: HomeConnectDescriptionStore,
): ReadonlySet<string> {
  return new Set(
    persisted
      .filter((b) => !isSyntheticKey(b.key) && description.entityByName(b.key) === undefined)
      .map((b) => b.key),
  )
}

/**
 * One row per Home Connect key. Two rows on one key are one entity filed twice (an identity from
 * the old catalog and the one derivation gave it): the older identity — the suffix that is NOT
 * the key's own slug — is the device the operator already has, so it stays and the twin leaves
 * (the kernel removes a child its spec no longer lists).
 */
function oneRowPerKey(
  rows: readonly HomeConnectChildBinding[],
): readonly HomeConnectChildBinding[] {
  const byKey = new Map<string, HomeConnectChildBinding>()
  for (const row of rows) {
    const held = byKey.get(row.key)
    if (held === undefined || (isDerivedSuffix(held) && !isDerivedSuffix(row))) {
      byKey.set(row.key, row)
    }
  }
  return [...byKey.values()]
}

/**
 * The bindings a container should carry: what the description derives now, plus what it
 * already had. A child leaves only when its entity is missing from TWO agreeing reads (D49):
 * `missingBefore` is what the previous read lacked — one description that omits an entity is
 * not enough to delete a device. A derived binding for a key the container already carries
 * keeps the existing child's `stableIdSuffix` and name, so a container saved before the
 * derived model (legacy children) keeps its device ids instead of being rebuilt.
 */
export function mergeChildBindings(
  persisted: readonly HomeConnectChildBinding[],
  derived: readonly HomeConnectChildBinding[],
  description: HomeConnectDescriptionStore,
  missingBefore: ReadonlySet<string> = new Set(),
): readonly HomeConnectChildBinding[] {
  const rows = oneRowPerKey(persisted.map(withCurrentLegacyKey))
  const missingNow = keysMissingFromDescription(rows, description)
  const out = new Map<string, HomeConnectChildBinding>()
  const suffixByKey = new Map<string, HomeConnectChildBinding>()
  for (const kept of rows) {
    if (missingNow.has(kept.key) && missingBefore.has(kept.key)) continue
    out.set(kept.stableIdSuffix, kept)
    suffixByKey.set(kept.key, kept)
  }
  for (const binding of derived) {
    const existing = suffixByKey.get(binding.key)
    const merged =
      existing === undefined
        ? binding
        : {
            ...binding,
            stableIdSuffix: existing.stableIdSuffix,
            name: existing.name,
          }
    out.set(merged.stableIdSuffix, merged)
  }
  return [...out.values()].toSorted((a, b) => a.stableIdSuffix.localeCompare(b.stableIdSuffix))
}

/**
 * Keeps each adopted appliance's child devices equal to what its description declares.
 * Runs on the addon, outside the container (rebuilding a container from inside itself
 * would tear down the code that asked for it).
 */
interface TrackedEntry {
  readonly unwatch: () => void
  timer: ReturnType<typeof setTimeout> | null
  readonly a: TrackedAppliance
  /** Keys the previous successful read found missing from the description (D49 second read). */
  missingBefore: ReadonlySet<string>
  /** Why the last pass derived nothing; logged on change only. */
  waiting: 'link-down' | 'description-missing' | null
}

export class HomeConnectChildReconciler {
  readonly #deps: HomeConnectChildReconcilerDeps
  readonly #tracked = new Map<number, TrackedEntry>()
  #stopped = false

  constructor(deps: HomeConnectChildReconcilerDeps) {
    this.#deps = deps
  }

  track(appliance: TrackedAppliance): void {
    if (this.#stopped || this.#tracked.has(appliance.deviceId)) return
    const entry: TrackedEntry = {
      a: appliance,
      timer: null,
      missingBefore: new Set(),
      waiting: null,
      unwatch: this.#deps.watch(appliance.brokerId, appliance.haId, () =>
        this.schedule(appliance.deviceId),
      ),
    }
    this.#tracked.set(appliance.deviceId, entry)
    this.schedule(appliance.deviceId)
  }

  untrack(deviceId: number): void {
    const entry = this.#tracked.get(deviceId)
    if (!entry) return
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.unwatch()
    this.#tracked.delete(deviceId)
  }

  stop(): void {
    this.#stopped = true
    for (const id of this.#tracked.keys()) this.untrack(id)
  }

  tracks(deviceId: number): boolean {
    return this.#tracked.has(deviceId)
  }

  private schedule(deviceId: number): void {
    const entry = this.#tracked.get(deviceId)
    if (!entry) return
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      void this.reconcile(deviceId)
    }, this.#deps.debounceMs ?? HOME_CONNECT_RECONCILE_DEBOUNCE_MS)
  }

  /** One pass for one appliance; exposed for the adoption path and tests. */
  async reconcile(deviceId: number): Promise<void> {
    const entry = this.#tracked.get(deviceId)
    if (!entry) return
    const { brokerId, haId } = entry.a
    const client = this.#deps.getClient(brokerId)
    const description = client?.getDescription(haId) ?? null
    // Nothing is derived from a link that is down or a description that is not loaded:
    // an empty read would otherwise look like "the appliance has no entities".
    const waiting =
      client === null || client.getLinkState(haId) !== 'connected'
        ? 'link-down'
        : description === null || description.state === 'missing'
          ? 'description-missing'
          : null
    if (waiting !== entry.waiting) {
      entry.waiting = waiting
      if (waiting !== null) {
        this.#deps.logger.info('Home Connect child reconcile waiting', {
          tags: { deviceId },
          meta: { haId, reason: waiting },
        })
      }
    }
    if (client === null || description === null || waiting !== null) return
    try {
      const { bindings: persisted, malformed } = await this.#deps.readPersisted(deviceId)
      if (malformed > 0) {
        // Writing now would silently drop those rows' children.
        this.#deps.logger.warn(
          'Home Connect child reconcile skipped — persisted rows are unreadable',
          {
            tags: { deviceId },
            meta: { malformed },
          },
        )
        return
      }
      const derived = deriveChildBindings({
        description,
        features: client.getFeatures(haId),
      })
      const merged = mergeChildBindings(persisted, derived, description, entry.missingBefore)
      // What this read lacked becomes the first of the two reads a removal needs.
      const missingNow = keysMissingFromDescription(merged, description)
      if (missingNow.size > 0 && missingNow.size !== entry.missingBefore.size) {
        this.#deps.logger.info('Home Connect children kept until a second read agrees they left', {
          tags: { deviceId },
          meta: { missing: [...missingNow] },
        })
      }
      entry.missingBefore = missingNow
      if (JSON.stringify(merged) === JSON.stringify(sorted(persisted))) return
      await this.#deps.applyEntities(deviceId, merged)
      this.#deps.logger.info('Home Connect children re-derived from the appliance description', {
        tags: { deviceId },
        meta: { before: persisted.length, after: merged.length },
      })
    } catch (err: unknown) {
      this.#deps.logger.warn('Home Connect child reconcile failed', {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
    }
  }
}

function sorted(list: readonly HomeConnectChildBinding[]): readonly HomeConnectChildBinding[] {
  return list.toSorted((a, b) => a.stableIdSuffix.localeCompare(b.stableIdSuffix))
}

/**
 * A container's persisted bindings from its config. One saved before the derived model has no
 * `entities`, only the legacy `children` the device publishes today: those ARE its bindings,
 * so the first derived write keeps them (same suffixes, same device ids) instead of reading
 * "no bindings" and rebuilding every child.
 */
export function persistedChildBindingsFromConfig(
  cfg: Readonly<Record<string, unknown>>,
): PersistedChildBindings {
  if (cfg['entities'] === undefined) {
    return { bindings: legacyChildBindings(cfg['children']), malformed: 0 }
  }
  return parsePersistedBindings(cfg['entities'])
}

export interface PersistedChildBindings {
  readonly bindings: readonly HomeConnectChildBinding[]
  readonly malformed: number
}

/**
 * Parse a container's persisted `entities`. A row that does not parse is COUNTED, not dropped
 * silently: the caller must not write a list that would lose it.
 */
export function parsePersistedBindings(raw: unknown): {
  readonly bindings: readonly HomeConnectChildBinding[]
  readonly malformed: number
} {
  if (!Array.isArray(raw)) return { bindings: [], malformed: 0 }
  const bindings: HomeConnectChildBinding[] = []
  let malformed = 0
  for (const row of raw) {
    const parsed = HomeConnectChildBindingSchema.safeParse(row)
    if (parsed.success) bindings.push(parsed.data)
    else malformed += 1
  }
  return { bindings, malformed }
}
