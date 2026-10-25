/**
 * An in-memory keychain + settings store for `BaseAddon` keychain specs.
 * Counts what matters for the "no churn" assertions: blob writes, keychain
 * puts (each one a new version) and `AddonUpdated` lifecycle events.
 */
import type { KeychainResolveResult, KeychainState } from '../../capabilities/keychain.cap.js'
import { EventCategory } from '../../enums/event-category.js'
import type { AddonContext } from '../../interfaces/addon.js'
import type { EventFilter, SystemEvent } from '../../interfaces/event-bus.js'
import { createSecretsAccess, type KeychainTransport } from '../../keychain/secrets-access.js'
import { fakeAddonContext } from './fake-addon-context.js'

export interface KeychainWorld {
  store: Record<string, unknown>
  devices: Map<number, Record<string, unknown>>
  kc: Map<string, { value: string; version: number }>
  /** `true` → every resolve answers `unavailable` and every put throws. */
  locked: boolean
  /** `true` → resolves answer `unavailable`, but puts still succeed (a flaky transport). */
  resolveFails: boolean
  handlers: Array<(e: SystemEvent) => void>
  blobWrites: number
  deviceWrites: number
  puts: number
  updatedEvents: number
}

export function newWorld(): KeychainWorld {
  return {
    store: {},
    devices: new Map(),
    kc: new Map(),
    locked: false,
    resolveFails: false,
    handlers: [],
    blobWrites: 0,
    deviceWrites: 0,
    puts: 0,
    updatedEvents: 0,
  }
}

function transport(w: KeychainWorld): KeychainTransport {
  return {
    async put({ ref, value }) {
      if (w.locked) throw new Error('keychain is locked (wrong-key)')
      w.puts++
      const version = (w.kc.get(ref)?.version ?? 0) + 1
      w.kc.set(ref, { value, version })
      return { ref, version }
    },
    async resolve({ refs }) {
      const out: KeychainResolveResult = {}
      for (const ref of refs) {
        const v = w.kc.get(ref)
        out[ref] =
          w.locked || w.resolveFails
            ? { kind: 'unavailable', reason: 'wrong-key' }
            : v
              ? { kind: 'value', value: v.value, version: v.version }
              : { kind: 'missing' }
      }
      return out
    },
    async delete({ refs }) {
      let deleted = 0
      for (const r of refs) if (w.kc.delete(r)) deleted++
      return { deleted }
    },
    async getState(): Promise<KeychainState> {
      return w.locked ? { state: 'locked', reason: 'wrong-key' } : { state: 'ready' }
    },
  }
}

export function worldContext(w: KeychainWorld, id: string): AddonContext {
  const base = fakeAddonContext({ id })
  const eventBus: AddonContext['eventBus'] = {
    emit: (e: SystemEvent) => {
      if (e.category === EventCategory.AddonUpdated) w.updatedEvents++
    },
    subscribe: (_f: EventFilter, h: (e: SystemEvent) => void) => {
      w.handlers.push(h)
      return () => undefined
    },
    getRecent: () => [],
  }
  const settings: NonNullable<AddonContext['settings']> = {
    ...(base.settings ?? fakeAddonContext().settings!),
    readAddonStore: async () => structuredClone(w.store),
    readAddonStoreResult: async () => ({ kind: 'value', value: structuredClone(w.store) }),
    readAddonStoreKeyResult: async (key) =>
      Object.prototype.hasOwnProperty.call(w.store, key)
        ? { kind: 'present', value: structuredClone(w.store[key]) }
        : { kind: 'absent' },
    writeAddonStore: async (patch) => {
      w.blobWrites++
      w.store = { ...w.store, ...structuredClone(patch) }
    },
    readDeviceStore: async (deviceId) => structuredClone(w.devices.get(deviceId) ?? {}),
    readDeviceStoreBatch: async (ids) =>
      new Map(ids.map((id) => [id, structuredClone(w.devices.get(id) ?? {})])),
    writeDeviceStore: async (deviceId, patch) => {
      w.deviceWrites++
      w.devices.set(deviceId, { ...w.devices.get(deviceId), ...structuredClone(patch) })
    },
  }
  return {
    ...base,
    eventBus,
    settings,
    secrets: createSecretsAccess({ owner: id, transport: transport(w), eventBus }),
  }
}
