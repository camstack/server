/**
 * The settings view an addon sees once the kernel provides a keychain.
 *
 * READ (D798) — every addon-facing read answers VALUES, never markers:
 * `readAddonStore`, `readAddonStoreResult`, `readAddonStoreKeyResult`,
 * `readDeviceStore`, `readDeviceStoreBatch`. Markers are resolved through the
 * addon's own `ctx.secrets` (owner-checked by the keychain, batched into one
 * round trip per read, served from its cache). A marker that cannot be
 * resolved STAYS a marker — "stored, unavailable right now" — and is reported
 * through `onUnresolved`; it never reads as `''` or as absent, which is what
 * invites a regenerate-and-save over the kept value. Three addons read their
 * raw config and got a marker in place of their secret in one evening after
 * the keychain migration (Wyze, ONVIF, Reolink); this is the root fix.
 *
 * WRITE (D787) — every write goes through the keychain save path, with the
 * write-back of a resolved read made idempotent (`secret-write-back.ts`): an
 * unchanged value becomes its marker again, nothing is put, a patch equal to
 * what is stored is not written at all.
 *
 * RAW — the marker-bearing blob is reachable only through the handle's `raw`
 * view, which `BaseAddon` keeps PRIVATE for the paths that need markers: the
 * admin form hydrate (markers become "set" views), config resolution (which
 * tracks unresolved refs for retry) and the save path itself. No addon code
 * can reach it.
 *
 * A Proxy rather than a copy: an in-process context carries getters (`api`)
 * and a spread would freeze them at wrap time; a Proxy forwards every other
 * property untouched, including to code that spreads the context.
 */
import type { AddonContext, AddonStoreRead } from '../interfaces/addon.js'
import type { SecretScope } from '../keychain/secret-ref.js'
import type { SecretsAccess } from '../keychain/secrets-access.js'
import type { SecretTree } from './secret-paths.js'
import {
  resolveSecretMarkers,
  transformSecretWrite,
  type UnresolvedSecret,
} from './secret-settings-view.js'
import {
  dropUnchangedKeys,
  markerKeysOf,
  restoreUnchangedSecrets,
  widenTreeWithStoredMarkers,
} from './secret-write-back.js'

type SettingsView = NonNullable<AddonContext['settings']>

export interface SecretAwareSettingsOptions {
  readonly secrets: SecretsAccess
  /** The addon store's secret tree (schema + `secretStatePaths`). */
  readonly addonTree: () => SecretTree
  /** The per-device store's secret tree. */
  readonly deviceTree: () => SecretTree
  /** Told about refs a write dropped but could not delete (they are now orphans). */
  readonly onOrphaned: (refs: readonly string[]) => void
  /** Is the write in progress the OPERATOR's (see `SecretWriteInput.operatorWrite`)? */
  readonly isOperatorWrite?: () => boolean
  /** Told when an addon-facing read met markers it could not resolve. */
  readonly onUnresolved?: (unresolved: readonly UnresolvedSecret[]) => void
}

/** Whether a write reached the store or the keychain. */
export interface SecretAwareWriteOutcome {
  readonly changed: boolean
}

export interface SecretAwareSettingsHandle {
  /** The view addon code gets: resolved reads, secret-aware writes. */
  readonly settings: SettingsView
  /**
   * The stored blobs WITH markers. For `BaseAddon`'s private use only — the
   * form hydrate, config resolution, the save path. Never hand it to addon code.
   */
  readonly raw: Pick<SettingsView, 'readAddonStore' | 'readDeviceStore'>
  /** `settings.writeAddonStore`, also saying whether anything changed. */
  writeAddonStore(patch: Record<string, unknown>): Promise<SecretAwareWriteOutcome>
}

/** The blob as stored now; a failed read REFUSES the write instead of guessing. */
async function readStoredAddonBlob(raw: SettingsView): Promise<Record<string, unknown>> {
  const threeWay = raw.readAddonStoreResult
  if (threeWay === undefined) return raw.readAddonStore()
  const result = await threeWay.call(raw)
  if (result.kind === 'failed') {
    throw new Error(`settings write refused: the stored blob could not be read (${result.error})`)
  }
  return result.kind === 'missing' ? {} : result.value
}

function touchesTree(tree: SecretTree, patch: Record<string, unknown>): boolean {
  if (tree.size === 0) return false
  for (const key of Object.keys(patch)) {
    const at = key.indexOf('@')
    if (tree.has(at > 0 ? key.slice(0, at) : key)) return true
  }
  return false
}

/**
 * Which top-level keys of each store held markers when last seen. `undefined`
 * for a store not seen yet: its first write reads it, to be safe.
 */
class MarkerKeyIndex {
  private readonly byStore = new Map<string, Set<string>>()

  constructor(private readonly owner: string) {}

  seen(store: string, blob: Record<string, unknown>): void {
    this.byStore.set(store, markerKeysOf(blob, this.owner))
  }

  wrote(store: string, patch: Record<string, unknown>): void {
    const keys = this.byStore.get(store)
    if (keys === undefined) return
    const now = markerKeysOf(patch, this.owner)
    for (const key of Object.keys(patch)) {
      if (now.has(key)) keys.add(key)
      else keys.delete(key)
    }
  }

  mayHoldMarkers(store: string, patch: Record<string, unknown>): boolean {
    const keys = this.byStore.get(store)
    if (keys === undefined) return true
    return Object.keys(patch).some((key) => keys.has(key))
  }
}

function createHandle(
  raw: SettingsView,
  opts: SecretAwareSettingsOptions,
): SecretAwareSettingsHandle {
  // One chain per store key: the read-transform-write of a secret save must
  // not interleave with another one on the same blob.
  const chains = new Map<string, Promise<unknown>>()
  const serialize = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = chains.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.catch(() => undefined)
    chains.set(key, tail)
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key)
    })
    return next
  }
  const index = new MarkerKeyIndex(opts.secrets.owner)

  const resolveRead = async (
    store: string,
    blob: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    index.seen(store, blob)
    const { value, unresolved } = await resolveSecretMarkers(blob, opts.secrets, {
      unresolved: 'keep-marker',
      ownedBy: opts.secrets.owner,
    })
    if (unresolved.length > 0) opts.onUnresolved?.(unresolved)
    return value
  }

  const write = async (
    store: string,
    declared: SecretTree,
    scope: SecretScope | undefined,
    patch: Record<string, unknown>,
    readStored: () => Promise<Record<string, unknown>>,
    rawWrite: (p: Record<string, unknown>) => Promise<void>,
  ): Promise<SecretAwareWriteOutcome> => {
    if (!touchesTree(declared, patch) && !index.mayHoldMarkers(store, patch)) {
      await rawWrite(patch)
      index.wrote(store, patch)
      return { changed: true }
    }
    return serialize(store, async () => {
      const stored = await readStored()
      index.seen(store, stored)
      const operatorWrite = opts.isOperatorWrite?.() === true
      const restored = await restoreUnchangedSecrets({
        patch,
        stored,
        secrets: opts.secrets,
        operatorWrite,
      })
      const tree = widenTreeWithStoredMarkers(
        declared,
        stored,
        Object.keys(restored.patch),
        opts.secrets.owner,
      )
      const result = await transformSecretWrite({
        tree,
        secrets: opts.secrets,
        patch: restored.patch,
        stored,
        ...(scope !== undefined ? { scope } : {}),
        operatorWrite,
      })
      const effective = dropUnchangedKeys(result.patch, stored)
      const wroteBlob = Object.keys(effective).length > 0
      if (wroteBlob) {
        await rawWrite(effective)
        index.wrote(store, effective)
      }
      const { orphaned } = await result.afterWrite()
      if (orphaned.length > 0) opts.onOrphaned(orphaned)
      return { changed: wroteBlob || restored.changedRefs.length > 0 }
    })
  }

  const writeAddon = (patch: Record<string, unknown>): Promise<SecretAwareWriteOutcome> =>
    write(
      'addon',
      opts.addonTree(),
      undefined,
      patch,
      () => readStoredAddonBlob(raw),
      (p) => raw.writeAddonStore(p),
    )

  const readAddonStoreResult = raw.readAddonStoreResult
  const readAddonStoreKeyResult = raw.readAddonStoreKeyResult

  const overrides: Partial<SettingsView> = {
    readAddonStore: async () => resolveRead('addon', await raw.readAddonStore()),
    ...(readAddonStoreResult !== undefined
      ? {
          readAddonStoreResult: async (): Promise<AddonStoreRead> => {
            const result = await readAddonStoreResult.call(raw)
            return result.kind === 'value'
              ? { kind: 'value', value: await resolveRead('addon', result.value) }
              : result
          },
        }
      : {}),
    ...(readAddonStoreKeyResult !== undefined
      ? {
          readAddonStoreKeyResult: async (key: string) => {
            const result = await readAddonStoreKeyResult.call(raw, key)
            if (result.kind !== 'present') return result
            const { value, unresolved } = await resolveSecretMarkers(
              { [key]: result.value },
              opts.secrets,
              { unresolved: 'keep-marker', ownedBy: opts.secrets.owner },
            )
            if (unresolved.length > 0) opts.onUnresolved?.(unresolved)
            return { kind: 'present', value: value[key] }
          },
        }
      : {}),
    readDeviceStore: async (deviceId) =>
      resolveRead(`device:${deviceId}`, await raw.readDeviceStore(deviceId)),
    readDeviceStoreBatch: async (deviceIds: readonly number[]) => {
      const rows = await raw.readDeviceStoreBatch(deviceIds)
      const out = new Map<number, Record<string, unknown>>()
      for (const [deviceId, blob] of rows) {
        out.set(deviceId, await resolveRead(`device:${deviceId}`, blob))
      }
      return out
    },
    writeAddonStore: async (patch) => {
      await writeAddon(patch)
    },
    writeDeviceStore: async (deviceId, patch) => {
      await write(
        `device:${deviceId}`,
        opts.deviceTree(),
        { kind: 'device', deviceId },
        patch,
        () => raw.readDeviceStore(deviceId),
        (p) => raw.writeDeviceStore(deviceId, p),
      )
    },
  }

  const settings = new Proxy(raw, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(overrides, prop)) {
        return Reflect.get(overrides, prop)
      }
      const value: unknown = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  return {
    settings,
    raw: {
      readAddonStore: async () => {
        const blob = await raw.readAddonStore()
        index.seen('addon', blob)
        return blob
      },
      readDeviceStore: async (deviceId) => {
        const blob = await raw.readDeviceStore(deviceId)
        index.seen(`device:${deviceId}`, blob)
        return blob
      },
    },
    writeAddonStore: writeAddon,
  }
}

/** The context the addon sees, plus the private raw view and write outcome. */
export function createSecretAwareContext(
  context: AddonContext,
  opts: SecretAwareSettingsOptions,
): { readonly context: AddonContext; readonly handle: SecretAwareSettingsHandle | null } {
  const raw = context.settings
  if (raw === undefined) return { context, handle: null }
  const handle = createHandle(raw, opts)
  const wrapped = new Proxy(context, {
    get(target, prop, receiver) {
      if (prop === 'settings') return handle.settings
      return Reflect.get(target, prop, receiver)
    },
  })
  return { context: wrapped, handle }
}

/** The context the addon sees: resolved reads, secret-aware writes. */
export function withSecretAwareSettings(
  context: AddonContext,
  opts: SecretAwareSettingsOptions,
): AddonContext {
  return createSecretAwareContext(context, opts).context
}
