/**
 * A driver's device-settings form on the keychain side of the wire (D789 for
 * device forms). After the keychain migration the stored blob holds a MARKER,
 * but the driver hydrates its form from the value `loadConfig` resolved for
 * it — so the browser used to receive the camera password in plaintext.
 *
 * Pinned here, generically (no driver is named):
 *  - the aggregate hands the browser the marker's VIEW, never the plaintext;
 *  - a value still inline in the blob (not migrated) keeps the driver's
 *    hydration — there is no ref to reveal it by;
 *  - a save of an untouched field keeps the stored secret (the view never
 *    reaches the driver); a typed value lands in the keychain through the
 *    driver's own persist; an explicit clear removes it.
 */
import {
  type AddonContext,
  createSecretsAccess,
  type KeychainResolveResult,
  type KeychainTransport,
  makeSecretMarker,
  SECRET_CLEAR,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  loadDeviceConfigWithSecrets,
  persistDeviceConfigWithSecrets,
} from '../device-config-secrets.js'
import {
  applyDriverFormPatch,
  splitDriverFormPatch,
  viewStoredSecrets,
} from '../device-form-secrets.js'
import type { ContributionShape } from '../device-meta-types.js'

const REF = 'secret://provider-hikvision/device/7/password'
const VIEW = { $secret: REF, v: 1, set: true }

/** What a driver hydrates: the RESOLVED plaintext, as `loadConfig` gave it. */
function driverSections(password: string): ContributionShape['sections'] {
  return [
    {
      id: 'connection',
      title: 'Connection',
      fields: [
        { type: 'text', key: 'host', label: 'Host', value: '10.0.0.7' },
        { type: 'password', key: 'password', label: 'Password', value: password },
        {
          type: 'group',
          key: 'advanced',
          label: 'Advanced',
          fields: [{ type: 'text', key: 'apiKey', label: 'API key', value: 'k-plain' }],
        },
      ],
    },
  ]
}

function valueOf(sections: ContributionShape['sections'], key: string): unknown {
  const walk = (fields: readonly unknown[]): unknown => {
    for (const f of fields) {
      const field = f as Record<string, unknown>
      if (field['key'] === key) return field['value']
      if (Array.isArray(field['fields'])) {
        const found = walk(field['fields'])
        if (found !== undefined) return found
      }
    }
    return undefined
  }
  for (const section of sections) {
    const found = walk(section.fields)
    if (found !== undefined) return found
  }
  return undefined
}

describe('device form — the browser receives the marker view, never the value', () => {
  it('a stored marker replaces the plaintext the driver hydrated; nothing else changes', () => {
    const out = viewStoredSecrets(
      driverSections('cam-pass-1'),
      { host: '10.0.0.7', password: makeSecretMarker(REF) },
      ['password'],
    )
    expect(valueOf(out, 'password')).toEqual(VIEW)
    expect(valueOf(out, 'host')).toBe('10.0.0.7')
    expect(JSON.stringify(out)).not.toContain('cam-pass-1')
  })

  it('a declared secret the driver draws as text, inside a group, becomes a password view', () => {
    const keyRef = 'secret://provider-hikvision/device/7/apiKey'
    const out = viewStoredSecrets(driverSections('p'), { apiKey: makeSecretMarker(keyRef) }, [
      'apiKey',
    ])
    const group = out[0]?.fields[2] as { fields: Array<Record<string, unknown>> }
    expect(group.fields[0]).toMatchObject({
      key: 'apiKey',
      type: 'password',
      value: { $secret: keyRef, v: 1, set: true },
    })
    expect(JSON.stringify(out)).not.toContain('k-plain')
  })

  it('a value still INLINE in the blob (not migrated) keeps the driver hydration', () => {
    const sections = driverSections('legacy-pass')
    const out = viewStoredSecrets(sections, { password: 'legacy-pass' }, ['password'])
    expect(out).toBe(sections)
    expect(valueOf(out, 'password')).toBe('legacy-pass')
  })

  it('a marker under a key no form field is, or under an undeclared text field, is left alone', () => {
    const out = viewStoredSecrets(
      driverSections('p'),
      { host: makeSecretMarker('secret://x/device/7/host') },
      ['password'],
    )
    expect(valueOf(out, 'host')).toBe('10.0.0.7')
  })
})

describe('device form — what the driver is handed on save', () => {
  it('an untouched view is dropped, a clear becomes "" plus a door clear, a typed value passes', () => {
    expect(
      splitDriverFormPatch({ host: 'h2', password: VIEW, apiKey: SECRET_CLEAR, pin: 'typed' }),
    ).toEqual({ driverPatch: { host: 'h2', apiKey: '', pin: 'typed' }, clearKeys: ['apiKey'] })
  })

  it('a patch of only an untouched secret never calls the driver', async () => {
    const applyToDriver = vi.fn(async () => {})
    const clearSecrets = vi.fn(async () => {})
    await applyDriverFormPatch({ patch: { password: VIEW }, applyToDriver, clearSecrets })
    expect(applyToDriver).not.toHaveBeenCalled()
    expect(clearSecrets).not.toHaveBeenCalled()
  })
})

// ── End to end through the real keychain door ──────────────────────────────

interface Kc {
  readonly values: Map<string, { value: string; version: number }>
}

function transport(kc: Kc): KeychainTransport {
  return {
    async put({ ref, value }) {
      const version = (kc.values.get(ref)?.version ?? 0) + 1
      kc.values.set(ref, { value, version })
      return { ref, version }
    },
    async resolve({ refs }) {
      const out: KeychainResolveResult = {}
      for (const ref of refs) {
        const v = kc.values.get(ref)
        out[ref] = v ? { kind: 'value', value: v.value, version: v.version } : { kind: 'missing' }
      }
      return out
    },
    async delete({ refs }) {
      for (const r of refs) kc.values.delete(r)
      return { deleted: refs.length }
    },
    async getState() {
      return { state: 'ready' }
    },
  }
}

function ctxFor(kc: Kc): AddonContext {
  const logger: AddonContext['logger'] = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  const secrets = createSecretsAccess({
    owner: 'device-manager',
    transport: transport(kc),
    transportForOwner: () => transport(kc),
  })
  return { logger, secrets } as unknown as AddonContext // the door reads these two members
}

/**
 * A migrated Hikvision camera: the blob holds the marker, the keychain the
 * value, and a driver that holds the RESOLVED config in memory and persists
 * the whole of it on every patch — as `BaseDevice` does.
 */
async function migratedCamera() {
  const kc: Kc = { values: new Map([[REF, { value: 'cam-pass-1', version: 1 }]]) }
  const ctx = ctxFor(kc)
  let blob: Record<string, unknown> = { host: '10.0.0.7', password: makeSecretMarker(REF) }
  const door = {
    ctx,
    readStored: async () => blob,
    write: async (patch: Record<string, unknown>) => {
      blob = { ...blob, ...patch }
    },
  }
  const persist = (data: Record<string, unknown>, operatorWrite: boolean) =>
    persistDeviceConfigWithSecrets(door, {
      deviceId: 7,
      ownerAddonId: 'provider-hikvision',
      data,
      secretPaths: ['password'],
      operatorWrite,
    })
  let driverConfig = await loadDeviceConfigWithSecrets(ctx, {
    deviceId: 7,
    ownerAddonId: 'provider-hikvision',
    stored: blob,
  })
  const save = (patch: Record<string, unknown>) =>
    applyDriverFormPatch({
      patch,
      applyToDriver: async (driverPatch) => {
        driverConfig = { ...driverConfig, ...driverPatch }
        await persist(driverConfig, false)
      },
      clearSecrets: (keys) => persist(Object.fromEntries(keys.map((k) => [k, SECRET_CLEAR])), true),
    })
  return {
    kc,
    save,
    blob: () => blob,
    driver: () => driverConfig,
    form: () =>
      viewStoredSecrets(driverSections(String(driverConfig['password'])), blob, ['password']),
  }
}

describe('device form — save through the keychain door', () => {
  it('the form the browser gets for a migrated camera carries no plaintext', async () => {
    const cam = await migratedCamera()
    expect(cam.driver()['password']).toBe('cam-pass-1')
    expect(JSON.stringify(cam.form())).not.toContain('cam-pass-1')
    expect(valueOf(cam.form(), 'password')).toEqual(VIEW)
  })

  it('saving another field with the secret untouched keeps the stored secret', async () => {
    const cam = await migratedCamera()
    const untouched = valueOf(cam.form(), 'password')
    await cam.save({ host: '10.0.0.8', password: untouched })
    expect(cam.blob()).toEqual({ host: '10.0.0.8', password: makeSecretMarker(REF) })
    expect(cam.kc.values.get(REF)?.value).toBe('cam-pass-1')
    expect(cam.driver()['password']).toBe('cam-pass-1')
  })

  it('a typed value lands in the keychain; the blob keeps only the marker', async () => {
    const cam = await migratedCamera()
    await cam.save({ password: 'cam-pass-2' })
    expect(cam.kc.values.get(REF)?.value).toBe('cam-pass-2')
    expect(cam.blob()['password']).toEqual(makeSecretMarker(REF))
    expect(cam.driver()['password']).toBe('cam-pass-2')
    expect(JSON.stringify(cam.form())).not.toContain('cam-pass-2')
  })

  it('an explicit clear removes the secret from the keychain and the blob', async () => {
    const cam = await migratedCamera()
    await cam.save({ password: SECRET_CLEAR })
    expect(cam.kc.values.has(REF)).toBe(false)
    expect(cam.blob()['password']).toBeNull()
    expect(cam.driver()['password']).toBe('')
  })
})

// ── Wired: the device-manager aggregate and its save route ─────────────────

describe('device-manager — the aggregate and the save route apply it', () => {
  async function setup() {
    const { CapabilityRegistry } = await import('../../../kernel/capability-registry.js')
    const { DeviceRegistry } = await import('../../../kernel/device-registry.js')
    const { deviceOpsCapability } = await import('@camstack/types')
    const { DeviceManagerAddon } = await import('../device-manager.addon.js')
    const { makeSettingsStoreApi } = await import('./settings-store-api.js')

    const kc: Kc = { values: new Map() }
    const base = ctxFor(kc)
    const logger = base.logger
    const deviceStores = new Map<number, Record<string, unknown>>()
    const settings = {
      readAddonStore: vi.fn(async () => ({})),
      writeAddonStore: vi.fn(async () => {}),
      readDeviceStore: vi.fn(async (id: number) => ({ ...deviceStores.get(id) })),
      writeDeviceStore: vi.fn(async (id: number, patch: Record<string, unknown>) => {
        deviceStores.set(id, { ...deviceStores.get(id), ...patch })
      }),
    }
    const capabilityRegistry = new CapabilityRegistry(logger)
    const { api: settingsStoreApi } = await makeSettingsStoreApi()
    const { makeRecordsAccessForOwner } = await import(
      '../../sqlite-storage/__tests__/support/records-world.js'
    )
    const records = await makeRecordsAccessForOwner('device-manager')
    const addon = new DeviceManagerAddon()
    const init = await addon.initialize({
      api: { settingsStore: settingsStoreApi },
      id: 'device-manager',
      logger,
      eventBus: { emit: vi.fn(), subscribe: () => () => {}, getRecent: () => [] },
      addonConfig: {},
      dataDir: '/tmp',
      settings,
      records,
      secrets: base.secrets,
      kernel: { deviceRegistry: new DeviceRegistry(), capabilityRegistry },
    } as unknown as AddonContext)
    const regs = Array.isArray(init) ? init : (init as { providers: unknown[] }).providers
    const provider = (regs[0] as { provider: Record<string, (i: unknown) => Promise<unknown>> })
      .provider
    const { id } = (await provider['allocateDeviceId']!({
      addonId: 'provider-hikvision',
      stableId: 'cam-7',
    })) as { id: number }
    await provider['registerDevice']!({
      addonId: 'provider-hikvision',
      stableId: 'cam-7',
      id,
      type: 'camera',
      name: 'Cam 7',
      parentDeviceId: null,
      config: {},
      secretConfigPaths: ['password'],
    })
    const ref = `secret://provider-hikvision/device/${id}/password`
    kc.values.set(ref, { value: 'cam-pass-1', version: 1 })
    deviceStores.set(id, { host: '10.0.0.7', password: makeSecretMarker(ref) })

    const setConfig = vi.fn(async () => ({ success: true as const }))
    capabilityRegistry.declareCapability(deviceOpsCapability)
    capabilityRegistry.registerNativeProvider(deviceOpsCapability.name, id, 'provider-hikvision', {
      // The forked driver hydrates from its resolved config: plaintext.
      getSettingsSchema: vi.fn(async () => ({ sections: driverSections('cam-pass-1') })),
      setConfig,
    })
    capabilityRegistry.ready()
    return { provider, id, ref, kc, setConfig, store: () => deviceStores.get(id) ?? {} }
  }

  it('getDeviceSettingsAggregate carries the view, not the driver plaintext', async () => {
    const { provider, id, ref } = await setup()
    const aggregate = (await provider['getDeviceSettingsAggregate']!({ deviceId: id })) as {
      sections: ContributionShape['sections']
    }
    expect(JSON.stringify(aggregate)).not.toContain('cam-pass-1')
    expect(valueOf(aggregate.sections, 'password')).toEqual({ $secret: ref, v: 1, set: true })
  })

  it('a save of the untouched view never reaches the driver; a clear reaches it as "" and removes the secret', async () => {
    const { provider, id, ref, kc, setConfig, store } = await setup()
    const view = { $secret: ref, v: 1, set: true }
    await provider['updateDeviceFieldsBatch']!({
      deviceId: id,
      changes: [
        {
          writerCapName: 'device-manager',
          writerAddonId: 'device-manager',
          key: 'host',
          value: 'h2',
        },
        {
          writerCapName: 'device-manager',
          writerAddonId: 'device-manager',
          key: 'password',
          value: view,
        },
      ],
    })
    expect(setConfig).toHaveBeenLastCalledWith({ deviceId: id, values: { host: 'h2' } })
    expect(kc.values.get(ref)?.value).toBe('cam-pass-1')

    await provider['updateDeviceFieldsBatch']!({
      deviceId: id,
      changes: [
        {
          writerCapName: 'device-manager',
          writerAddonId: 'device-manager',
          key: 'password',
          value: SECRET_CLEAR,
        },
      ],
    })
    expect(setConfig).toHaveBeenLastCalledWith({ deviceId: id, values: { password: '' } })
    expect(kc.values.has(ref)).toBe(false)
    expect(store()['password']).toBeNull()
  })
})
