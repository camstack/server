/**
 * The discovery default password is a keychain secret (D787).
 *
 * Regression (2026-10-08): the global form was served by a `getGlobalSettings`
 * override while `globalSettingsSchema()` stayed null, so the addon's secret
 * tree was empty and `defaultPassword` was stored as plaintext. Declaring the
 * schema makes the store hold a marker — so the read side must resolve it,
 * or discovery would hand every camera an empty password.
 */
import {
  createSecretsAccess,
  isSecretMarker,
  makeSecretMarker,
  type AddonContext,
  type KeychainResolveResult,
  type KeychainTransport,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../onvif-discovery.js', () => ({
  discoverOnvifCameras: async () => [{ host: '192.168.10.10', port: 80, name: 'Cam' }],
}))

const { OnvifProviderAddon } = await import('../addon.js')

const PLAIN = 'onvif-default-password-canary'
const REF = 'secret://provider-onvif/global/defaultPassword'

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
  withTags: () => noopLogger,
}

function contextFor(w: World): AddonContext {
  const eventBus = { emit: () => undefined, subscribe: () => () => undefined, getRecent: () => [] }
  return {
    id: 'provider-onvif',
    logger: noopLogger,
    eventBus,
    kernel: { localNodeId: 'hub' },
    settings: {
      readAddonStore: async () => structuredClone(w.store),
      readAddonStoreResult: async () => ({ kind: 'value', value: structuredClone(w.store) }),
      writeAddonStore: async (patch: Record<string, unknown>) => {
        w.store = { ...w.store, ...structuredClone(patch) }
      },
      readDeviceStore: async () => ({}),
      writeDeviceStore: async () => undefined,
    },
    secrets: createSecretsAccess({
      owner: 'provider-onvif',
      transport: transport(w),
      eventBus: eventBus as unknown as AddonContext['eventBus'],
    }),
  } as unknown as AddonContext
}

let addon: InstanceType<typeof OnvifProviderAddon> | null = null
afterEach(async () => {
  await addon?.shutdown()
  addon = null
})

async function boot(w: World) {
  addon = new OnvifProviderAddon()
  await addon.initialize(contextFor(w))
  return addon
}

describe('ONVIF defaultPassword through the keychain', () => {
  it('an operator write stores a marker, never the plaintext', async () => {
    const w: World = { store: {}, kc: new Map() }
    const a = await boot(w)

    await a.updateGlobalSettingsAsOperator({ defaultUsername: 'admin', defaultPassword: PLAIN })

    expect(JSON.stringify(w.store)).not.toContain(PLAIN)
    expect(isSecretMarker(w.store['defaultPassword'])).toBe(true)
    expect(w.store['defaultUsername']).toBe('admin')
  })

  it('after the write, discovery prefills the RESOLVED password', async () => {
    const w: World = { store: {}, kc: new Map() }
    const a = await boot(w)
    await a.updateGlobalSettingsAsOperator({ defaultUsername: 'admin', defaultPassword: PLAIN })

    const [candidate] = await a.discoverDevices()

    expect(candidate?.prefilledConfig['username']).toBe('admin')
    expect(candidate?.prefilledConfig['password']).toBe(PLAIN)
  })

  it('a marker already stored at boot resolves for discovery (restart path)', async () => {
    const w: World = {
      store: { defaultUsername: 'admin', defaultPassword: makeSecretMarker(REF) },
      kc: new Map([[REF, { value: PLAIN, version: 1 }]]),
    }
    const a = await boot(w)

    const [candidate] = await a.discoverDevices()

    expect(candidate?.prefilledConfig['password']).toBe(PLAIN)
  })

  it('the settings form never carries the plaintext', async () => {
    const w: World = { store: {}, kc: new Map() }
    const a = await boot(w)
    await a.updateGlobalSettingsAsOperator({ defaultPassword: PLAIN })

    const view = await a.getGlobalSettings()

    expect(JSON.stringify(view)).not.toContain(PLAIN)
  })
})
