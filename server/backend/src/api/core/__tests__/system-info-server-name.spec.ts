import { describe, expect, it } from 'vitest'
import { buildSystemProvider } from '../cap-providers.js'

/**
 * D861 - `system.info` (the call the admin UI already makes once signed in)
 * carries the hub's name next to the feature flags, `{ name, isDefault }`.
 */

const MANIFEST = {
  streaming: true,
  notifications: true,
  objectDetection: true,
  remoteAccess: true,
  agentCluster: true,
  smartHome: true,
  recordings: true,
  backup: true,
  repl: false,
}

function providerWith(stored: unknown) {
  const registry = {
    getSingleton: (cap: string) =>
      cap === 'settings-store' ? { get: async () => stored, set: async () => undefined } : null,
    getCollectionEntries: () => [],
  }
  return buildSystemProvider({ getManifest: () => MANIFEST } as never, registry as never)
}

describe('system.info carries the server name', () => {
  it('unset: the hostname default, flagged', async () => {
    const info = await providerWith(undefined).info(undefined as never)
    expect(info.serverName.isDefault).toBe(true)
    expect(info.serverName.name.length).toBeGreaterThan(0)
  })

  it('set: the chosen name, not the default', async () => {
    const info = await providerWith('Casa Napoli').info(undefined as never)
    expect(info.serverName).toEqual({ name: 'Casa Napoli', isDefault: false })
  })

  it('keeps every feature flag it carried before', async () => {
    const info = await providerWith('Casa').info(undefined as never)
    expect(info).toMatchObject(MANIFEST)
  })
})
