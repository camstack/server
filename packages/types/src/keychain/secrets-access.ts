/**
 * `ctx.secrets` — an addon's handle on its OWN keychain values.
 *
 * The owner is closed over at construction (the addon's id); nothing a caller
 * passes can change it. How the call travels is the transport's business:
 *
 *  - hub in-process builtin: the provider is in the same process, so the
 *    transport states the owner explicitly (`callerAddonId`) — the one place a
 *    claim is trusted, because no wire is involved;
 *  - forked runner / agent addon: the transport sends the bare input and the
 *    parent (or the agent, through `$hub-cap-fwd`) stamps who is calling.
 *
 * The cache holds `ref → {value, version}` with no expiry while the version is
 * current. `keychain.changed` drops an entry; an entry older than
 * {@link REVALIDATE_AFTER_MS} is re-fetched on its next use (the safety net
 * for a dropped event, D8). A failed fetch answers the last good value when
 * there is one — a locked keychain never turns a working credential into an
 * empty one — and `unavailable` otherwise, never `missing`.
 */
import type {
  KeychainResolveEntry,
  KeychainResolveResult,
  KeychainState,
} from '../capabilities/keychain.cap.js'
import { EventCategory } from '../enums/event-category.js'
import type { IEventBus } from '../interfaces/event-bus.js'
import { forgetKnownSecret, registerKnownSecret } from './known-secrets.js'
import { buildSecretRef, normalizeSecretOwner, type SecretScope } from './secret-ref.js'

/** Re-fetch a cached value after this long, even with no change event. */
export const REVALIDATE_AFTER_MS = 15 * 60_000

/** The four calls a {@link SecretsAccess} makes. `callerAddonId` is set only in-process. */
export interface KeychainTransport {
  put(input: {
    readonly ref: string
    readonly value: string
  }): Promise<{ readonly ref: string; readonly version: number }>
  resolve(input: { readonly refs: readonly string[] }): Promise<KeychainResolveResult>
  delete(input: { readonly refs: readonly string[] }): Promise<{ readonly deleted: number }>
  getState(): Promise<KeychainState>
  /** The device-removed purge (D864) — the device manager's transport only. */
  deleteDeviceScope?(input: {
    readonly deviceId: number
  }): Promise<{ readonly refs: readonly string[] }>
}

export interface SecretsAccess {
  /** The owner every ref of this handle belongs to. */
  readonly owner: string
  /** Build this owner's ref for a field. */
  ref(scope: SecretScope, fieldPath: string): string
  /** Resolve refs in one call; cached values are served without one. */
  resolve(refs: readonly string[]): Promise<KeychainResolveResult>
  /** Store a value. Throws while the keychain is locked. */
  put(ref: string, value: string): Promise<number>
  /** Remove refs. Unknown refs are ignored. */
  delete(refs: readonly string[]): Promise<number>
  /** Whether values can be stored right now. */
  state(): Promise<KeychainState>
  /**
   * Subscribe to changes of refs this handle has served. The handler runs
   * after the cache dropped the ref. Returns the unsubscribe.
   */
  onChange(handler: (ref: string) => void): () => void
  /**
   * In-process SYSTEM builtins only (device-manager, storage-orchestrator):
   * act as a door for another owner's values. `null` everywhere else — a
   * forked addon has no way to state an identity the transport would accept.
   */
  readonly forOwner: ((owner: string) => SecretsAccess) | null
  /**
   * The device manager only (D864): delete every value scoped `device/<id>`,
   * whatever its owner, when the device is removed. The keychain refuses any
   * other caller; absent where the transport has no such door.
   */
  readonly deleteDeviceScope?: (deviceId: number) => Promise<readonly string[]>
}

interface CacheEntry {
  readonly value: string
  readonly version: number
  readonly fetchedAt: number
}

export interface SecretsAccessOptions {
  readonly owner: string
  readonly transport: KeychainTransport
  /** Builds the transport for another owner — in-process system builtins only. */
  readonly transportForOwner?: (owner: string) => KeychainTransport
  readonly eventBus?: Pick<IEventBus, 'subscribe'>
  readonly now?: () => number
}

function unavailableAll(refs: readonly string[]): KeychainResolveResult {
  const out: Record<string, KeychainResolveEntry> = {}
  for (const ref of refs) out[ref] = { kind: 'unavailable', reason: 'not-initialized' }
  return out
}

export function createSecretsAccess(opts: SecretsAccessOptions): SecretsAccess {
  const owner = normalizeSecretOwner(opts.owner)
  const now = opts.now ?? Date.now
  const cache = new Map<string, CacheEntry>()
  const handlers = new Set<(ref: string) => void>()
  /** One delegate handle per owner — each holds a cache and a subscription. */
  const delegates = new Map<string, SecretsAccess>()

  const drop = (ref: string): void => {
    const entry = cache.get(ref)
    if (entry === undefined) return
    cache.delete(ref)
    forgetKnownSecret(entry.value)
    for (const handler of handlers) {
      try {
        handler(ref)
      } catch {
        /* a broken subscriber must not stop the others */
      }
    }
  }

  opts.eventBus?.subscribe({ category: EventCategory.KeychainChanged }, (event) => {
    const data: unknown = event.data
    if (data === null || typeof data !== 'object') return
    const ref: unknown = Reflect.get(data, 'ref')
    const version: unknown = Reflect.get(data, 'version')
    if (typeof ref !== 'string') return
    const entry = cache.get(ref)
    if (entry === undefined) return
    if (typeof version === 'number' && version === entry.version) return
    drop(ref)
  })

  const remember = (ref: string, value: string, version: number): void => {
    const previous = cache.get(ref)
    if (previous !== undefined && previous.value !== value) forgetKnownSecret(previous.value)
    cache.set(ref, { value, version, fetchedAt: now() })
    registerKnownSecret(value, ref)
  }

  const access: SecretsAccess = {
    owner,
    ref: (scope, fieldPath) => buildSecretRef({ owner, scope, fieldPath }),

    async resolve(refs) {
      const out: Record<string, KeychainResolveEntry> = {}
      const toFetch: string[] = []
      const t = now()
      for (const ref of new Set(refs)) {
        const hit = cache.get(ref)
        if (hit !== undefined && t - hit.fetchedAt < REVALIDATE_AFTER_MS) {
          out[ref] = { kind: 'value', value: hit.value, version: hit.version }
        } else {
          toFetch.push(ref)
        }
      }
      if (toFetch.length === 0) return out
      let fetched: KeychainResolveResult
      try {
        fetched = await opts.transport.resolve({ refs: toFetch })
      } catch {
        fetched = unavailableAll(toFetch)
      }
      for (const ref of toFetch) {
        const entry: KeychainResolveEntry = fetched[ref] ?? {
          kind: 'unavailable',
          reason: 'not-initialized',
        }
        if (entry.kind === 'value') {
          remember(ref, entry.value, entry.version)
          out[ref] = entry
          continue
        }
        if (entry.kind === 'unavailable') {
          // Last good value wins over "unavailable": a locked keychain must
          // not take a running credential away.
          const stale = cache.get(ref)
          out[ref] =
            stale !== undefined
              ? { kind: 'value', value: stale.value, version: stale.version }
              : entry
          continue
        }
        if (cache.has(ref)) drop(ref)
        out[ref] = entry
      }
      return out
    },

    async put(ref, value) {
      const result = await opts.transport.put({ ref, value })
      remember(ref, value, result.version)
      return result.version
    },

    async delete(refs) {
      if (refs.length === 0) return 0
      const result = await opts.transport.delete({ refs })
      for (const ref of refs) drop(ref)
      return result.deleted
    },

    state: () => opts.transport.getState(),

    ...(opts.transport.deleteDeviceScope === undefined
      ? {}
      : {
          deleteDeviceScope: async (deviceId: number): Promise<readonly string[]> => {
            const purge = opts.transport.deleteDeviceScope
            if (purge === undefined) return []
            const { refs } = await purge.call(opts.transport, { deviceId })
            for (const ref of refs) drop(ref)
            return refs
          },
        }),

    onChange(handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },

    forOwner:
      opts.transportForOwner === undefined
        ? null
        : (other: string): SecretsAccess => {
            const target = normalizeSecretOwner(other)
            const existing = delegates.get(target)
            if (existing !== undefined) return existing
            const build = opts.transportForOwner
            if (build === undefined) throw new Error('forOwner: no delegate transport')
            const delegate = createSecretsAccess({
              owner: target,
              transport: build(target),
              ...(opts.eventBus !== undefined ? { eventBus: opts.eventBus } : {}),
              now,
            })
            delegates.set(target, delegate)
            return delegate
          },
  }
  return access
}
