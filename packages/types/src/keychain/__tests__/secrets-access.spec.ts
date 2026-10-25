import { afterEach, describe, expect, it } from 'vitest'
import type { KeychainResolveResult, KeychainState } from '../../capabilities/keychain.cap.js'
import { EventCategory } from '../../enums/event-category.js'
import type { EventFilter, SystemEvent } from '../../interfaces/event-bus.js'
import { clearKnownSecrets, scrubKnownSecrets } from '../known-secrets.js'
import {
  createSecretsAccess,
  type KeychainTransport,
  REVALIDATE_AFTER_MS,
} from '../secrets-access.js'

interface FakeKeychain {
  values: Map<string, { value: string; version: number }>
  locked: boolean
  resolveCalls: number
}

function fakeTransport(kc: FakeKeychain): KeychainTransport {
  return {
    async put({ ref, value }) {
      if (kc.locked) throw new Error('keychain locked')
      const version = (kc.values.get(ref)?.version ?? 0) + 1
      kc.values.set(ref, { value, version })
      return { ref, version }
    },
    async resolve({ refs }) {
      kc.resolveCalls++
      const out: Record<string, KeychainResolveResult[string]> = {}
      for (const ref of refs) {
        if (kc.locked) {
          out[ref] = { kind: 'unavailable', reason: 'wrong-key' }
          continue
        }
        const hit = kc.values.get(ref)
        out[ref] = hit
          ? { kind: 'value', value: hit.value, version: hit.version }
          : { kind: 'missing' }
      }
      return out
    },
    async delete({ refs }) {
      let deleted = 0
      for (const ref of refs) if (kc.values.delete(ref)) deleted++
      return { deleted }
    },
    async getState(): Promise<KeychainState> {
      return kc.locked ? { state: 'locked', reason: 'wrong-key' } : { state: 'ready' }
    },
  }
}

function fakeBus(): {
  bus: { subscribe(filter: EventFilter, handler: (e: SystemEvent) => void): () => void }
  emit(data: Record<string, unknown>): void
} {
  const handlers: Array<(e: SystemEvent) => void> = []
  return {
    bus: {
      subscribe(_filter, handler) {
        handlers.push(handler)
        return () => undefined
      },
    },
    emit(data) {
      for (const h of handlers) {
        h({
          id: 'e',
          timestamp: new Date(),
          source: { type: 'addon', id: 'keychain' },
          category: EventCategory.KeychainChanged,
          data,
        })
      }
    },
  }
}

const REF = 'secret://cloudflare-tunnel/global/customApiToken'

describe('ctx.secrets', () => {
  afterEach(() => clearKnownSecrets())

  it('serves cached values without a round-trip until the version changes', async () => {
    const kc: FakeKeychain = { values: new Map(), locked: false, resolveCalls: 0 }
    const { bus, emit } = fakeBus()
    const secrets = createSecretsAccess({
      owner: 'cloudflare-tunnel',
      transport: fakeTransport(kc),
      eventBus: bus,
    })
    await secrets.put(REF, 'token-value-one')
    expect(await secrets.resolve([REF])).toEqual({
      [REF]: { kind: 'value', value: 'token-value-one', version: 1 },
    })
    expect(kc.resolveCalls).toBe(0)

    // A keychain-only change (no blob write) reaches the runtime: the event
    // drops the cached copy and the next resolve reads the new value.
    kc.values.set(REF, { value: 'token-value-two', version: 2 })
    emit({ ref: REF, owner: 'cloudflare-tunnel', version: 2, change: 'put' })
    expect((await secrets.resolve([REF]))[REF]).toEqual({
      kind: 'value',
      value: 'token-value-two',
      version: 2,
    })
    expect(kc.resolveCalls).toBe(1)
  })

  it('revalidates a cached value after the safety-net window even with no event', async () => {
    const kc: FakeKeychain = { values: new Map(), locked: false, resolveCalls: 0 }
    let t = 1_000
    const secrets = createSecretsAccess({ owner: 'x', transport: fakeTransport(kc), now: () => t })
    await secrets.put(REF, 'first-value-long')
    kc.values.set(REF, { value: 'second-value-long', version: 2 })
    t += REVALIDATE_AFTER_MS + 1
    expect((await secrets.resolve([REF]))[REF]).toMatchObject({ value: 'second-value-long' })
  })

  it('a locked keychain answers unavailable — never missing, never empty', async () => {
    const kc: FakeKeychain = {
      values: new Map([[REF, { value: 'v-long-enough', version: 1 }]]),
      locked: true,
      resolveCalls: 0,
    }
    const secrets = createSecretsAccess({ owner: 'x', transport: fakeTransport(kc) })
    expect((await secrets.resolve([REF]))[REF]).toEqual({
      kind: 'unavailable',
      reason: 'wrong-key',
    })
  })

  it('keeps the last good value when the keychain becomes unavailable', async () => {
    const kc: FakeKeychain = {
      values: new Map([[REF, { value: 'good-value-1', version: 1 }]]),
      locked: false,
      resolveCalls: 0,
    }
    let t = 0
    const secrets = createSecretsAccess({ owner: 'x', transport: fakeTransport(kc), now: () => t })
    await secrets.resolve([REF])
    kc.locked = true
    t += REVALIDATE_AFTER_MS + 1
    expect((await secrets.resolve([REF]))[REF]).toEqual({
      kind: 'value',
      value: 'good-value-1',
      version: 1,
    })
  })

  it('a transport failure is unavailable, not missing', async () => {
    const transport: KeychainTransport = {
      put: async () => {
        throw new Error('down')
      },
      resolve: async () => {
        throw new Error('down')
      },
      delete: async () => ({ deleted: 0 }),
      getState: async () => ({ state: 'locked', reason: 'not-initialized' }),
    }
    const secrets = createSecretsAccess({ owner: 'x', transport })
    expect((await secrets.resolve([REF]))[REF]).toEqual({
      kind: 'unavailable',
      reason: 'not-initialized',
    })
  })

  it('registers resolved values with the log scrubber, and forgets deleted ones', async () => {
    const kc: FakeKeychain = { values: new Map(), locked: false, resolveCalls: 0 }
    const secrets = createSecretsAccess({ owner: 'x', transport: fakeTransport(kc) })
    await secrets.put(REF, 'super-secret-token-123')
    const line = scrubKnownSecrets('cloudflared --token super-secret-token-123 failed')
    expect(line).not.toContain('super-secret-token-123')
    expect(line).toMatch(/‹secret:[0-9a-f]{8}›/)
    await secrets.delete([REF])
    expect(scrubKnownSecrets('x super-secret-token-123')).toContain('super-secret-token-123')
  })

  it('a forked handle cannot delegate; an in-process one memoises its delegates', () => {
    const kc: FakeKeychain = { values: new Map(), locked: false, resolveCalls: 0 }
    const forked = createSecretsAccess({ owner: 'x', transport: fakeTransport(kc) })
    expect(forked.forOwner).toBeNull()
    const inProcess = createSecretsAccess({
      owner: 'device-manager',
      transport: fakeTransport(kc),
      transportForOwner: () => fakeTransport(kc),
    })
    const a = inProcess.forOwner?.('provider-onvif')
    expect(a?.owner).toBe('provider-onvif')
    expect(inProcess.forOwner?.('provider-onvif')).toBe(a)
  })
})
