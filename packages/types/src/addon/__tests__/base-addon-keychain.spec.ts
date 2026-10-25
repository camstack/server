import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { KeychainResolveResult, KeychainState } from '../../capabilities/keychain.cap.js'
import { EventCategory } from '../../enums/event-category.js'
import type { AddonContext } from '../../interfaces/addon.js'
import type { ConfigUISchema } from '../../interfaces/config-ui.js'
import type { EventFilter, SystemEvent } from '../../interfaces/event-bus.js'
import { clearKnownSecrets } from '../../keychain/known-secrets.js'
import { isSecretMarker, makeSecretMarker } from '../../keychain/secret-marker.js'
import { createSecretsAccess, type KeychainTransport } from '../../keychain/secrets-access.js'
import { BaseAddon } from '../base-addon.js'
import { fakeAddonContext } from './fake-addon-context.js'

/**
 * The §6.9-style canaries that hold WITHOUT any migration code (D787):
 *  - a keychain-only change is seen by the running addon;
 *  - a restart re-resolves;
 *  - a wrong key is `unavailable` — never an empty credential, never written back;
 *  - `''` never clears; the form never receives the value.
 */

interface Config {
  host: string
  apiToken: string
  signingKey: string
}

class CanaryAddon extends BaseAddon<Config> {
  protected override readonly secretStatePaths = ['signingKey']
  configChanges = 0

  constructor() {
    super({ host: '', apiToken: '', signingKey: '' })
  }

  protected async onInitialize() {
    return []
  }

  protected override async onConfigChanged(): Promise<void> {
    this.configChanges++
  }

  protected override globalSettingsSchema(): ConfigUISchema {
    return {
      sections: [
        {
          id: 's',
          title: 's',
          fields: [
            { type: 'text', key: 'host', label: 'Host' },
            { type: 'password', key: 'apiToken', label: 'API token' },
          ],
        },
      ],
    }
  }

  get unresolved() {
    return this.unresolvedSecrets
  }

  signing() {
    return this.state('signingKey', z.string(), '')
  }

  forget() {
    return this.clearSecrets(['apiToken', 'host'])
  }
}

interface World {
  store: Record<string, unknown>
  kc: Map<string, { value: string; version: number }>
  locked: boolean
  handlers: Array<(e: SystemEvent) => void>
}

function transport(w: World): KeychainTransport {
  return {
    async put({ ref, value }) {
      if (w.locked) throw new Error('keychain is locked (wrong-key)')
      const version = (w.kc.get(ref)?.version ?? 0) + 1
      w.kc.set(ref, { value, version })
      return { ref, version }
    },
    async resolve({ refs }) {
      const out: KeychainResolveResult = {}
      for (const ref of refs) {
        const v = w.kc.get(ref)
        out[ref] = w.locked
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

function contextFor(w: World): AddonContext {
  const base = fakeAddonContext({ id: 'canary' })
  const eventBus: AddonContext['eventBus'] = {
    emit: () => undefined,
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
    writeAddonStore: async (patch) => {
      w.store = { ...w.store, ...structuredClone(patch) }
    },
  }
  return {
    ...base,
    eventBus,
    settings,
    secrets: createSecretsAccess({ owner: 'canary', transport: transport(w), eventBus }),
  }
}

const REF = 'secret://canary/global/apiToken'

function emitChange(w: World, ref: string, version: number): void {
  for (const h of w.handlers) {
    h({
      id: 'x',
      timestamp: new Date(),
      source: { type: 'addon', id: 'keychain' },
      category: EventCategory.KeychainChanged,
      data: { ref, owner: 'canary', version, change: 'put' },
    })
  }
}

describe('BaseAddon on the keychain', () => {
  let w: World
  beforeEach(() => {
    w = { store: {}, kc: new Map(), locked: false, handlers: [] }
  })
  afterEach(() => {
    clearKnownSecrets()
    vi.useRealTimers()
  })

  it('a form save stores a marker; the value lives in the keychain; the form gets "set", never the value', async () => {
    const addon = new CanaryAddon()
    await addon.initialize(contextFor(w))
    await addon.updateGlobalSettings({ host: 'h', apiToken: 'canary-token-123' })
    expect(w.store).toEqual({ host: 'h', apiToken: makeSecretMarker(REF) })
    expect(addon.config.apiToken).toBe('canary-token-123')
    const form = await addon.getGlobalSettings()
    expect(JSON.stringify(form)).not.toContain('canary-token-123')
    const field = form?.sections[0]?.fields.find((f) => 'key' in f && f.key === 'apiToken')
    expect(field && 'value' in field ? field.value : undefined).toEqual({
      $secret: REF,
      v: 1,
      set: true,
    })
  })

  it("'' never clears, and the untouched form round-trips without a write to the keychain", async () => {
    const addon = new CanaryAddon()
    await addon.initialize(contextFor(w))
    await addon.updateGlobalSettings({ apiToken: 'canary-token-123' })
    await addon.updateGlobalSettings({ apiToken: '' })
    expect(w.store['apiToken']).toEqual(makeSecretMarker(REF))
    expect(addon.config.apiToken).toBe('canary-token-123')
    const form = await addon.getGlobalSettings()
    const view = form?.sections[0]?.fields.find((f) => 'key' in f && f.key === 'apiToken')
    await addon.updateGlobalSettings({
      apiToken: view && 'value' in view ? (view.value as string) : '',
    })
    expect(w.kc.get(REF)?.version).toBe(1)
  })

  it('a keychain-ONLY change (no blob write) reaches the running addon', async () => {
    vi.useFakeTimers()
    w.store = { apiToken: makeSecretMarker(REF) }
    w.kc.set(REF, { value: 'canary-v1-value', version: 1 })
    const addon = new CanaryAddon()
    await addon.initialize(contextFor(w))
    expect(addon.config.apiToken).toBe('canary-v1-value')
    w.kc.set(REF, { value: 'canary-v2-value', version: 2 })
    emitChange(w, REF, 2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(addon.config.apiToken).toBe('canary-v2-value')
    expect(addon.configChanges).toBe(1)
  })

  it('a restart re-resolves from the keychain', async () => {
    w.store = { apiToken: makeSecretMarker(REF) }
    w.kc.set(REF, { value: 'canary-v1-value', version: 1 })
    const first = new CanaryAddon()
    await first.initialize(contextFor(w))
    await first.shutdown()
    w.kc.set(REF, { value: 'canary-v3-value', version: 3 })
    const second = new CanaryAddon()
    await second.initialize(contextFor(w))
    expect(second.config.apiToken).toBe('canary-v3-value')
  })

  it('a wrong key is unavailable: no empty-string credential is invented and nothing is written back', async () => {
    w.store = { apiToken: makeSecretMarker(REF) }
    w.kc.set(REF, { value: 'canary-v1-value', version: 1 })
    w.locked = true
    const addon = new CanaryAddon()
    await addon.initialize(contextFor(w))
    expect(addon.unresolved).toEqual([{ ref: REF, reason: 'wrong-key' }])
    expect(w.store).toEqual({ apiToken: makeSecretMarker(REF) })
    await addon.shutdown()
  })

  it('strict: while locked, a new value is refused rather than stored in plaintext', async () => {
    w.locked = true
    const addon = new CanaryAddon()
    await addon.initialize(contextFor(w))
    await expect(addon.updateGlobalSettings({ apiToken: 'canary-token-123' })).rejects.toThrow(
      /not saved/,
    )
    expect(JSON.stringify(w.store)).not.toContain('canary-token-123')
    await addon.shutdown()
  })

  it('hidden state declared in secretStatePaths goes to the keychain and reads back as its value', async () => {
    const addon = new CanaryAddon()
    await addon.initialize(contextFor(w))
    await addon.signing().set('signing-key-abcdef')
    expect(isSecretMarker(w.store['signingKey'])).toBe(true)
    expect(await addon.signing().get()).toBe('signing-key-abcdef')
  })

  it("clearSecrets is the explicit way to forget a stored secret ('' would keep it)", async () => {
    const addon = new CanaryAddon()
    await addon.initialize(contextFor(w))
    await addon.updateGlobalSettings({ apiToken: 'canary-token-123' })
    await addon.forget()
    expect(w.store['apiToken']).toBeNull()
    expect(w.kc.has(REF)).toBe(false)
    expect(addon.config.apiToken).toBe('')
  })

  it('no silent migration: an addon writing back an inline value keeps it; the operator re-entering it moves it', async () => {
    w.store = { apiToken: 'legacy-inline-token' }
    const addon = new CanaryAddon()
    await addon.initialize(contextFor(w))
    expect(addon.config.apiToken).toBe('legacy-inline-token')
    await addon.updateGlobalSettings({ apiToken: addon.config.apiToken })
    expect(w.store['apiToken']).toBe('legacy-inline-token')
    await addon.updateGlobalSettingsAsOperator({ apiToken: 'legacy-inline-token' })
    expect(w.store['apiToken']).toEqual(makeSecretMarker(REF))
    expect(addon.config.apiToken).toBe('legacy-inline-token')
  })

  it('without a keychain (older kernel, tests) the store behaves exactly as before', async () => {
    const ctx = { ...contextFor(w) }
    const { secrets: _omitted, ...withoutSecrets } = ctx
    const addon = new CanaryAddon()
    await addon.initialize(withoutSecrets)
    await addon.updateGlobalSettings({ apiToken: 'plain-token-1' })
    expect(w.store['apiToken']).toBe('plain-token-1')
  })
})
