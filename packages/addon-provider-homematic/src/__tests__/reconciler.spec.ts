/**
 * D49 for the Homematic integrations: a read that failed, came back empty or held no usable
 * connection changes nothing about devices. They are removed only on an explicit
 * Deleted/Disabled event that names the integration.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  HomematicReconciler,
  type ReconcilerClients,
  type ReconcilerIntegration,
} from '../homematic-reconciler.js'

const logger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
  withTags: () => logger,
}

const ADDON = 'provider-homematic'
const A: ReconcilerIntegration = { id: 'int-a', addonId: ADDON, name: 'A', enabled: true }
const B: ReconcilerIntegration = { id: 'int-b', addonId: ADDON, name: 'B', enabled: true }

function harness(
  list: () => Promise<readonly ReconcilerIntegration[]>,
  apply: (i: ReconcilerIntegration) => Promise<boolean> = async () => true,
) {
  const live = new Set<string>(['int-a', 'int-b'])
  const removedDevices: string[] = []
  const clients: ReconcilerClients = {
    list: () => [...live],
    remove: async (id) => void live.delete(id),
  }
  const reconciler = new HomematicReconciler({
    addonId: ADDON,
    logger,
    clients,
    listIntegrations: list,
    applySettings: apply,
    removeDevices: async (id) => {
      removedDevices.push(id)
      return 3
    },
  })
  return { reconciler, live, removedDevices }
}

describe('Homematic reconcile never removes devices on an unanswered read', () => {
  it('a failed list changes nothing', async () => {
    const h = harness(async () => {
      throw new Error('list down')
    })
    await h.reconciler.onLifecycle('enabled', null)
    expect(h.removedDevices).toEqual([])
    expect([...h.live].sort()).toEqual(['int-a', 'int-b'])
  })

  it('settings that throw or hold no connection leave devices and the client alone', async () => {
    const h = harness(
      async () => [A, B],
      async (i) => {
        if (i.id === 'int-a') throw new Error('boom')
        return false
      },
    )
    await h.reconciler.onLifecycle('enabled', 'int-a')
    expect(h.removedDevices).toEqual([])
    expect([...h.live].sort()).toEqual(['int-a', 'int-b'])
  })

  it('an empty list removes no devices on an Enabled event', async () => {
    const h = harness(async () => [])
    await h.reconciler.onLifecycle('enabled', 'int-b')
    expect(h.removedDevices).toEqual([])
  })

  it('an explicit Deleted names the integration and removes only its devices', async () => {
    const h = harness(async () => [B])
    await h.reconciler.onLifecycle('deleted', 'int-a')
    expect(h.removedDevices).toEqual(['int-a'])
    expect(h.live.has('int-a')).toBe(false)
    expect(h.live.has('int-b')).toBe(true)
  })
})
