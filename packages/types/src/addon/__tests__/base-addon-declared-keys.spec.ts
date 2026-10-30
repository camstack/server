/**
 * The addon answers, in its OWN process, which global-settings keys it still
 * declares (stale-data audit), and removes a key the audit proved stale
 * together with the keychain values that key held.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ConfigUISchema } from '../../interfaces/config-ui.js'
import { clearKnownSecrets } from '../../keychain/known-secrets.js'
import { makeSecretMarker } from '../../keychain/secret-marker.js'
import { BaseAddon } from '../base-addon.js'
import { type KeychainWorld, newWorld, worldContext } from './keychain-world.js'

interface Config {
  host: string
  retries: number
}

class DeclaringAddon extends BaseAddon<Config> {
  protected override readonly secretStatePaths = ['signing.key', 'tokens[userId].accessToken']

  constructor() {
    super({ host: '', retries: 3 })
  }

  protected async onInitialize() {
    return []
  }

  protected override globalSettingsSchema(): ConfigUISchema {
    return {
      sections: [
        {
          id: 's',
          title: 's',
          fields: [
            { type: 'text', key: 'host', label: 'Host' },
            {
              type: 'group',
              key: 'adv',
              label: 'Advanced',
              fields: [{ type: 'text', key: 'nested', label: 'Nested' }],
            },
            { type: 'password', key: 'apiToken', label: 'API token' },
          ],
        },
      ],
    }
  }

  openState() {
    return this.state('cursor', z.number(), 0)
  }
}

function withRemoval(w: KeychainWorld) {
  const ctx = worldContext(w, 'declaring')
  const settings = ctx.settings
  if (settings === undefined) throw new Error('no settings')
  return {
    ...ctx,
    settings: {
      ...settings,
      writeAddonStore: async (patch: Record<string, unknown>) => {
        await settings.writeAddonStore(patch)
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) delete w.store[key]
        }
      },
    },
  }
}

const STALE_REF = 'secret://declaring/global/providers[0].clientSecret'
const KEPT_REF = 'secret://declaring/global/apiToken'

afterEach(() => clearKnownSecrets())

describe('BaseAddon.getDeclaredSettingsKeys', () => {
  it('is defaults + schema fields (group children) + state keys + secretStatePaths roots', async () => {
    const addon = new DeclaringAddon()
    await addon.initialize(worldContext(newWorld(), 'declaring'))
    addon.openState()
    const { keys } = await addon.getDeclaredSettingsKeys()
    expect(keys).toEqual(
      ['apiToken', 'cursor', 'host', 'nested', 'retries', 'signing', 'tokens'].toSorted(),
    )
  })

  it('does not list a key the addon no longer declares', async () => {
    const addon = new DeclaringAddon()
    await addon.initialize(worldContext(newWorld(), 'declaring'))
    const { keys } = await addon.getDeclaredSettingsKeys()
    expect(keys).not.toContain('providers')
  })
})

describe('BaseAddon.unsetStoredSettingsKeys', () => {
  it('removes a stale key and clears the keychain value its marker pointed at', async () => {
    const w = newWorld()
    w.store = {
      host: 'h',
      apiToken: makeSecretMarker(KEPT_REF),
      providers: [{ id: 'a', clientSecret: makeSecretMarker(STALE_REF) }],
    }
    w.kc.set(STALE_REF, { value: 'stale-secret-value', version: 1 })
    w.kc.set(KEPT_REF, { value: 'kept-secret-value', version: 1 })
    const addon = new DeclaringAddon()
    await addon.initialize(withRemoval(w))

    const outcome = await addon.unsetStoredSettingsKeys(['providers'])

    expect(outcome.removed).toEqual(['providers'])
    expect(w.store).not.toHaveProperty('providers')
    expect(w.store['host']).toBe('h')
    expect(w.kc.has(STALE_REF)).toBe(false)
    expect(w.kc.has(KEPT_REF)).toBe(true)
    expect(outcome.secretsCleared).toBe(1)
  })

  it('refuses a key the addon still declares, and a key that is not stored', async () => {
    const w = newWorld()
    w.store = { host: 'h' }
    const addon = new DeclaringAddon()
    await addon.initialize(withRemoval(w))

    const outcome = await addon.unsetStoredSettingsKeys(['host', 'never-written'])

    expect(outcome.removed).toEqual([])
    expect(outcome.refused.map((r) => r.key).toSorted()).toEqual(['host', 'never-written'])
    expect(w.store['host']).toBe('h')
  })

  it('keeps a keychain value another stored key still points at', async () => {
    const w = newWorld()
    w.store = {
      apiToken: makeSecretMarker(KEPT_REF),
      legacyCopy: makeSecretMarker(KEPT_REF),
    }
    w.kc.set(KEPT_REF, { value: 'shared-secret-value', version: 1 })
    const addon = new DeclaringAddon()
    await addon.initialize(withRemoval(w))

    const outcome = await addon.unsetStoredSettingsKeys(['legacyCopy'])

    expect(outcome.removed).toEqual(['legacyCopy'])
    expect(w.kc.has(KEPT_REF)).toBe(true)
    expect(outcome.secretsCleared).toBe(0)
  })
})
