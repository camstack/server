import { describe, it, expect } from 'vitest'
import { ServiceBroker } from 'moleculer'
import { createHubService } from '../../moleculer/hub-service.js'
import type { HubServiceDeps } from '../../moleculer/hub-service.js'
import type { RegisterNodeParams } from '../../moleculer/node-registry.js'

function baseDeps(overrides: Partial<HubServiceDeps>): HubServiceDeps {
  return {
    getAddonConfig: () => ({}),
    getSettings: () => ({}),
    getRecentEvents: () => [],
    onLog: () => {},
    ...overrides,
  }
}

describe('$hub.registerNode', () => {
  it('invokes onRegisterNode with the full manifest and returns { ok: true }', async () => {
    const received: RegisterNodeParams[] = []
    const broker = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    broker.createService(
      createHubService(
        baseDeps({
          onRegisterNode: (p) => received.push(p),
        }),
      ),
    )
    await broker.start()
    try {
      const params: RegisterNodeParams = {
        nodeId: 'hub/reolink',
        addons: [{ addonId: 'reolink', capabilities: ['switch', 'ptz'] }],
      }
      const result = await broker.call('$hub.registerNode', params)
      expect(result).toEqual({ ok: true })
      expect(received).toEqual([params])
    } finally {
      await broker.stop()
    }
  })

  it('forwards the optional nativeCaps field verbatim to onRegisterNode', async () => {
    const received: RegisterNodeParams[] = []
    const broker = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    broker.createService(
      createHubService(
        baseDeps({
          onRegisterNode: (p) => received.push(p),
        }),
      ),
    )
    await broker.start()
    try {
      const params: RegisterNodeParams = {
        nodeId: 'hub/reolink',
        addons: [{ addonId: 'reolink', capabilities: ['onvif'] }],
        nativeCaps: [{ addonId: 'reolink', capName: 'switch', deviceIds: [7, 12] }],
      }
      const result = await broker.call('$hub.registerNode', params)
      expect(result).toEqual({ ok: true })
      expect(received).toEqual([params])
    } finally {
      await broker.stop()
    }
  })

  it('$hub.unregisterNode invokes onUnregisterNode with the nodeId', async () => {
    const removed: string[] = []
    const broker = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    broker.createService(
      createHubService(
        baseDeps({
          onUnregisterNode: (nodeId) => removed.push(nodeId),
        }),
      ),
    )
    await broker.start()
    try {
      await broker.call('$hub.unregisterNode', { nodeId: 'hub/reolink' })
      expect(removed).toEqual(['hub/reolink'])
    } finally {
      await broker.stop()
    }
  })
})
