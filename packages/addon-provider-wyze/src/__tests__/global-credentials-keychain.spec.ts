/**
 * Wyze account credentials have ONE home: the integration settings. The
 * addon's global store is only the wizard's schema carrier.
 *
 * Regression (D787 migration, 2026-10-08): `getGlobalSettings()` was
 * overridden to expose the credential form, but `globalSettingsSchema()`
 * returned null — so the addon's secret tree was EMPTY, and every write of
 * `password` / `apiKey` to the global store (the migration's own operator
 * write included) bypassed the keychain and landed as plaintext.
 */
import {
  createSecretsAccess,
  isSecretMarker,
  type AddonContext,
  type KeychainResolveResult,
  type KeychainTransport,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { WyzeProviderAddon } from '../addon.js'

const PLAIN_PASSWORD = 'pw-plaintext-canary'
const PLAIN_API_KEY = 'apikey-plaintext-canary'

interface World {
  store: Record<string, unknown>
  kc: Map<string, { value: string; version: number }>
}

function transport(w: World): KeychainTransport {
  return {
    async put({ ref, value }) {
      const version = (w.kc.get(ref)?.version ?? 0) + 1
      w.kc.set(ref, { value, version })
      return { ref, version }
    },
    async resolve({ refs }) {
      const out: KeychainResolveResult = {}
      for (const ref of refs) {
        const v = w.kc.get(ref)
        out[ref] = v ? { kind: 'value', value: v.value, version: v.version } : { kind: 'missing' }
      }
      return out
    },
    async delete({ refs }) {
      let deleted = 0
      for (const r of refs) if (w.kc.delete(r)) deleted++
      return { deleted }
    },
    async getState() {
      return { state: 'ready' }
    },
  }
}

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
}

function contextFor(w: World): AddonContext {
  const eventBus = {
    emit: () => undefined,
    subscribe: () => () => undefined,
    getRecent: () => [],
  }
  const settings = {
    readAddonStore: async () => structuredClone(w.store),
    readAddonStoreResult: async () => ({ kind: 'value', value: structuredClone(w.store) }),
    writeAddonStore: async (patch: Record<string, unknown>) => {
      w.store = { ...w.store, ...structuredClone(patch) }
    },
    readDeviceStore: async () => ({}),
    writeDeviceStore: async () => undefined,
  }
  return {
    id: 'provider-wyze',
    logger: noopLogger,
    eventBus,
    settings,
    kernel: { localNodeId: 'hub' },
    secrets: createSecretsAccess({
      owner: 'provider-wyze',
      transport: transport(w),
      eventBus: eventBus as unknown as AddonContext['eventBus'],
    }),
  } as unknown as AddonContext
}

/** The addon minus its cloud/integration wiring: only the global-store contract. */
class GlobalStoreOnlyWyze extends WyzeProviderAddon {
  protected override async onInitialize() {
    await this.purgeStaleGlobalCredentials()
    return []
  }
}

async function boot(w: World): Promise<GlobalStoreOnlyWyze> {
  const addon = new GlobalStoreOnlyWyze()
  await addon.initialize(contextFor(w))
  return addon
}

function plaintextIn(blob: Record<string, unknown>): string[] {
  const json = JSON.stringify(blob)
  return [PLAIN_PASSWORD, PLAIN_API_KEY].filter((p) => json.includes(p))
}

describe('Wyze global store: credentials never stored as plaintext', () => {
  it('an operator write of password/apiKey (the migration path) stores keychain markers', async () => {
    const w: World = { store: {}, kc: new Map() }
    const addon = await boot(w)

    await addon.updateGlobalSettingsAsOperator({ password: PLAIN_PASSWORD, apiKey: PLAIN_API_KEY })

    expect(plaintextIn(w.store)).toEqual([])
    expect(isSecretMarker(w.store['password'])).toBe(true)
    expect(isSecretMarker(w.store['apiKey'])).toBe(true)
  })

  it('an addon write-back of a resolved config object stores markers, never plaintext', async () => {
    const w: World = { store: {}, kc: new Map() }
    const addon = await boot(w)

    await addon.updateGlobalSettings({ password: PLAIN_PASSWORD, apiKey: PLAIN_API_KEY })

    expect(plaintextIn(w.store)).toEqual([])
    expect(isSecretMarker(w.store['password'])).toBe(true)
    expect(isSecretMarker(w.store['apiKey'])).toBe(true)
  })

  it('stale global credentials (dead: the addon reads the integration) are removed on boot', async () => {
    const w: World = {
      store: {
        email: 'someone@example.com',
        password: PLAIN_PASSWORD,
        apiKey: PLAIN_API_KEY,
        apiId: 'key-id',
      },
      kc: new Map(),
    }

    await boot(w)

    expect(plaintextIn(w.store)).toEqual([])
    for (const key of ['email', 'password', 'apiKey', 'apiId']) {
      const v = w.store[key]
      expect(typeof v === 'string' && v.length > 0).toBe(false)
      expect(isSecretMarker(v)).toBe(false)
    }
    expect(w.kc.size).toBe(0)
  })

  it('a clean store is not written on boot', async () => {
    const w: World = { store: {}, kc: new Map() }
    await boot(w)
    expect(w.store).toEqual({})
  })

  it('the wizard form is served empty — the global store never surfaces values', async () => {
    const w: World = { store: {}, kc: new Map() }
    const addon = await boot(w)
    await addon.updateGlobalSettingsAsOperator({ password: PLAIN_PASSWORD })

    const view = await addon.getGlobalSettings()

    expect(JSON.stringify(view)).not.toContain(PLAIN_PASSWORD)
    const keys = view?.sections.flatMap((s) => s.fields.map((f) => ('key' in f ? f.key : '')))
    expect(keys).toEqual(expect.arrayContaining(['email', 'password', 'apiKey', 'apiId']))
  })
})
