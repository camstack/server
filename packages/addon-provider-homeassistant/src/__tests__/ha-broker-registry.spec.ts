import { describe, it, expect } from 'vitest'
import type { IEventBus, IScopedLogger, SystemEvent } from '@camstack/types'
import {
  HaBrokerEntrySchema,
  HaBrokerRegistry,
  settingsToAuth,
  authToSettings,
} from '../ha-broker-registry.js'

/** Real-shaped no-op logger — the invalid-settings path never logs, but
 *  the registry constructor requires a logger reference. */
function buildNoopLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

/** Real-shaped no-op event bus — never invoked on the invalid-settings
 *  path, but the registry constructor requires an event bus reference. */
function buildNoopEventBus(): IEventBus {
  return {
    emit() {},
    subscribe: () => () => {},
    getRecent: (): readonly SystemEvent[] => [],
  }
}

describe('HA broker registry — settings <-> auth coercion', () => {
  describe('settingsToAuth', () => {
    it('builds long-lived auth from {baseUrl, accessToken}', () => {
      const result = settingsToAuth({
        baseUrl: 'https://ha.example:8123',
        accessToken: 'll-token',
      })
      expect(result).toEqual({
        kind: 'long-lived',
        baseUrl: 'https://ha.example:8123',
        accessToken: 'll-token',
      })
    })

    it('builds supervisor auth from {supervisorToken}', () => {
      const result = settingsToAuth({ supervisorToken: 'sup-tok' })
      expect(result).toEqual({ kind: 'supervisor', supervisorToken: 'sup-tok' })
    })

    it('rejects empty settings', () => {
      expect(() => settingsToAuth({})).toThrow()
    })

    it('rejects long-lived with malformed URL', () => {
      expect(() => settingsToAuth({ baseUrl: 'not-a-url', accessToken: 'x' })).toThrow()
    })

    it('rejects long-lived with empty token', () => {
      expect(() =>
        settingsToAuth({ baseUrl: 'https://ha.example:8123', accessToken: '' }),
      ).toThrow()
    })

    it('rejects supervisor with empty token', () => {
      expect(() => settingsToAuth({ supervisorToken: '' })).toThrow()
    })

    it('rejects mixed/extraneous fields without resolving kind', () => {
      // Has neither full long-lived nor supervisor — Zod union rejects both branches.
      expect(() => settingsToAuth({ baseUrl: 'https://ha.example:8123' })).toThrow()
    })
  })

  describe('authToSettings', () => {
    it('serialises long-lived auth', () => {
      expect(
        authToSettings({
          kind: 'long-lived',
          baseUrl: 'https://ha.example:8123',
          accessToken: 'll-token',
        }),
      ).toEqual({
        baseUrl: 'https://ha.example:8123',
        accessToken: 'll-token',
      })
    })

    it('serialises supervisor auth', () => {
      expect(
        authToSettings({
          kind: 'supervisor',
          supervisorToken: 'sup-tok',
        }),
      ).toEqual({ supervisorToken: 'sup-tok' })
    })

    it('round-trips long-lived through settings -> auth -> settings', () => {
      const original = {
        baseUrl: 'https://ha.example:8123',
        accessToken: 'll-token',
      }
      const reparsed = authToSettings(settingsToAuth(original))
      expect(reparsed).toEqual(original)
    })

    it('round-trips supervisor through settings -> auth -> settings', () => {
      const original = { supervisorToken: 'sup-tok' }
      const reparsed = authToSettings(settingsToAuth(original))
      expect(reparsed).toEqual(original)
    })
  })

  describe('HaBrokerEntry schema validation', () => {
    it('accepts a long-lived entry', () => {
      const entry = {
        id: 'b1',
        name: 'Casa',
        auth: {
          kind: 'long-lived' as const,
          baseUrl: 'https://ha.example:8123',
          accessToken: 'll',
        },
      }
      expect(HaBrokerEntrySchema.parse(entry)).toEqual(entry)
    })

    it('accepts a supervisor entry', () => {
      const entry = {
        id: 'b1',
        name: 'Local HA',
        auth: { kind: 'supervisor' as const, supervisorToken: 'sup' },
      }
      expect(HaBrokerEntrySchema.parse(entry)).toEqual(entry)
    })

    it('rejects auth with unknown kind', () => {
      expect(() =>
        HaBrokerEntrySchema.parse({
          id: 'b1',
          name: 'x',
          auth: { kind: 'oauth', token: 'x' },
        }),
      ).toThrow()
    })
  })

  describe('integration ↔ broker index', () => {
    it('linkIntegration + getBrokerIdByIntegrationId returns the linked brokerId', () => {
      const registry = new HaBrokerRegistry(buildNoopLogger(), buildNoopEventBus())
      registry.linkIntegration('int-1', 'ha_007')
      expect(registry.getBrokerIdByIntegrationId('int-1')).toBe('ha_007')
    })

    it('getBrokerIdByIntegrationId throws for an unlinked integrationId', () => {
      const registry = new HaBrokerRegistry(buildNoopLogger(), buildNoopEventBus())
      expect(() => registry.getBrokerIdByIntegrationId('nope')).toThrow()
    })

    it('removeEntry clears the index even when no manager was started', async () => {
      // Fix-1 scenario: a broker linked via linkIntegration whose manager
      // never started must not leak a stale integrationToBroker entry.
      const registry = new HaBrokerRegistry(buildNoopLogger(), buildNoopEventBus())
      registry.linkIntegration('int-1', 'ha_007')
      await registry.removeEntry('ha_007')
      expect(() => registry.getBrokerIdByIntegrationId('int-1')).toThrow()
    })
  })

  describe('testSettings — invalid settings (no network)', () => {
    it('returns ok:false for empty settings without opening a client', async () => {
      const registry = new HaBrokerRegistry(buildNoopLogger(), buildNoopEventBus())
      const result = await registry.testSettings({})
      expect(result.ok).toBe(false)
      if (!result.ok) expect(typeof result.error).toBe('string')
    })

    it('returns ok:false for a malformed baseUrl without opening a client', async () => {
      const registry = new HaBrokerRegistry(buildNoopLogger(), buildNoopEventBus())
      const result = await registry.testSettings({ baseUrl: 'not-a-url', accessToken: 'x' })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(typeof result.error).toBe('string')
    })
  })
})

describe('adopting an id — restoring a broker that was lost', () => {
  /**
   * Written after the outage this exists to prevent: the HA broker was deleted,
   * re-adding minted `ha_001`, and 15 devices stayed bound to `ha_004` because
   * an HA device carries the broker id inside its `stableId`. Re-creating under
   * the ORIGINAL id is what turns that migration back into typing a password.
   */
  it('returns the requested id unchanged', () => {
    const registry = new HaBrokerRegistry(buildNoopLogger(), buildNoopEventBus())
    expect(registry.adoptId('ha_004')).toBe('ha_004')
  })

  it('advances the counter PAST an adopted id', () => {
    // The subtle one. The counter is seeded from stored entries at load only,
    // so adopting ha_004 while it sits at 1 would let the next automatic
    // allocation mint ha_004 again — two brokers, one id.
    const registry = new HaBrokerRegistry(buildNoopLogger(), buildNoopEventBus())
    registry.adoptId('ha_004')
    expect(registry.allocateId()).toBe('ha_005')
  })

  it('does not REWIND the counter for a low adopted id', () => {
    const registry = new HaBrokerRegistry(buildNoopLogger(), buildNoopEventBus())
    expect(registry.allocateId()).toBe('ha_001')
    expect(registry.allocateId()).toBe('ha_002')
    registry.adoptId('ha_001-restored')
    expect(registry.allocateId()).toBe('ha_003')
  })

  it('leaves a non-progressive id alone but still returns it', () => {
    const registry = new HaBrokerRegistry(buildNoopLogger(), buildNoopEventBus())
    expect(registry.adoptId('legacy-broker')).toBe('legacy-broker')
    expect(registry.allocateId()).toBe('ha_001')
  })
})

describe('adopting an id NEVER overwrites a live broker', () => {
  it('refuses an id that already has a manager', async () => {
    // The dangerous direction. Adopting a LIVE id would replace that broker in
    // config while its devices keep pointing at the id — now serving someone
    // else's Home Assistant. Restoring is for a broker that is GONE.
    const registry = new HaBrokerRegistry(buildNoopLogger(), buildNoopEventBus())
    const entry = await registry.createEntry('first', {
      baseUrl: 'https://ha.invalid:8123',
      accessToken: 'tok',
    })
    expect(() => registry.adoptId(entry.id)).toThrow(/already in use/)
    await registry.shutdown()
  })

  it('allows adopting an id that was removed', async () => {
    const registry = new HaBrokerRegistry(buildNoopLogger(), buildNoopEventBus())
    const entry = await registry.createEntry('first', {
      baseUrl: 'https://ha.invalid:8123',
      accessToken: 'tok',
    })
    await registry.removeEntry(entry.id)
    expect(registry.adoptId(entry.id)).toBe(entry.id)
    await registry.shutdown()
  })
})
