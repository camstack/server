/**
 * D49 for the Ecowitt integrations: a read that failed or could not be served (locked keychain,
 * unreadable settings, a list that did not answer) changes nothing. Devices are removed only on an
 * explicit Deleted/Disabled event that names the integration.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { EcowittSettingsRead } from '../ecowitt-instances.js'
import {
  EcowittReconciler,
  type ReconcilerClients,
  type ReconcilerIntegration,
} from '../ecowitt-reconciler.js'

const logs: string[] = []
const logger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (m: string) => void logs.push(m),
  error: () => undefined,
  child: () => logger,
  withTags: () => logger,
}

const ADDON = 'provider-ecowitt'
const A: ReconcilerIntegration = { id: 'int-a', addonId: ADDON, name: 'A', enabled: true }
const B: ReconcilerIntegration = { id: 'int-b', addonId: ADDON, name: 'B', enabled: true }

const LOCAL: EcowittSettingsRead = {
  values: { transport: 'local', host: '192.168.1.50', port: 80, password: 'pw' },
  secretsLocked: false,
}
/** The keychain refused: the record comes back WITHOUT its password, and says so. */
const LOCKED: EcowittSettingsRead = {
  values: { transport: 'local', host: '192.168.1.50', port: 80 },
  secretsLocked: true,
}
const NONE: EcowittSettingsRead = { values: {}, secretsLocked: false }

function harness(
  settings: Record<string, EcowittSettingsRead | Error>,
  list: () => Promise<readonly ReconcilerIntegration[]>,
) {
  const live = new Set<string>(['int-a', 'int-b'])
  const removedDevices: string[] = []
  const clients: ReconcilerClients = {
    list: () => [...live],
    upsert: async (id) => void live.add(id),
    remove: async (id) => void live.delete(id),
  }
  const reconciler = new EcowittReconciler({
    addonId: ADDON,
    logger,
    clients,
    listIntegrations: list,
    readSettings: async (id) => {
      const v = settings[id]
      if (v instanceof Error) throw v
      return v ?? NONE
    },
    removeDevices: async (id) => {
      removedDevices.push(id)
      return 3
    },
  })
  return { reconciler, live, removedDevices }
}

describe('Ecowitt reconcile never removes devices on an unanswered read', () => {
  it('a locked keychain on A, then an event on B: zero devices removed, A keeps its client', async () => {
    const h = harness({ 'int-a': LOCKED, 'int-b': LOCAL }, async () => [A, B])
    await h.reconciler.onLifecycle('enabled', 'int-b')
    expect(h.removedDevices).toEqual([])
    expect(h.live.has('int-a')).toBe(true)
  })

  it('settings that throw, a missing connection and a failed list all change nothing', async () => {
    const throwing = harness({ 'int-a': new Error('boom'), 'int-b': NONE }, async () => [A, B])
    await throwing.reconciler.onLifecycle('enabled', 'int-a')
    expect(throwing.removedDevices).toEqual([])
    expect([...throwing.live].sort()).toEqual(['int-a', 'int-b'])

    const unanswered = harness({}, async () => {
      throw new Error('list down')
    })
    await unanswered.reconciler.onLifecycle('enabled', null)
    expect(unanswered.removedDevices).toEqual([])
    expect([...unanswered.live].sort()).toEqual(['int-a', 'int-b'])
  })

  it('an explicit Deleted names the integration and removes only its devices', async () => {
    const h = harness({ 'int-b': LOCAL }, async () => [B])
    await h.reconciler.onLifecycle('deleted', 'int-a')
    expect(h.removedDevices).toEqual(['int-a'])
    expect(h.live.has('int-a')).toBe(false)
    expect(h.live.has('int-b')).toBe(true)
  })
})
