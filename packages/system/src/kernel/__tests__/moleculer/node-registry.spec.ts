import { describe, it, expect } from 'vitest'
import { HubNodeRegistry } from '../../moleculer/node-registry.js'
import type { RegisterNodeParams } from '../../moleculer/node-registry.js'

function params(nodeId: string, addons: Array<[string, string[]]>): RegisterNodeParams {
  return { nodeId, addons: addons.map(([addonId, capabilities]) => ({ addonId, capabilities })) }
}

describe('HubNodeRegistry', () => {
  it('stores a node manifest and exposes it as a flat (nodeId, addonId, capName) view', () => {
    const reg = new HubNodeRegistry()
    reg.registerNode(params('hub/reolink', [['reolink', ['switch', 'ptz']]]))
    const flat = reg.listEntries()
    expect(flat).toEqual([
      { nodeId: 'hub/reolink', addonId: 'reolink', capName: 'switch' },
      { nodeId: 'hub/reolink', addonId: 'reolink', capName: 'ptz' },
    ])
  })

  it('registerNode REPLACES the node entire cap set atomically (idempotent)', () => {
    const reg = new HubNodeRegistry()
    reg.registerNode(params('hub/reolink', [['reolink', ['switch', 'ptz']]]))
    reg.registerNode(params('hub/reolink', [['reolink', ['switch']]]))
    expect(reg.listEntries()).toEqual([
      { nodeId: 'hub/reolink', addonId: 'reolink', capName: 'switch' },
    ])
  })

  it('removeNode drops every entry for that node', () => {
    const reg = new HubNodeRegistry()
    reg.registerNode(params('hub/a', [['a', ['cap-a']]]))
    reg.registerNode(params('hub/b', [['b', ['cap-b']]]))
    reg.removeNode('hub/a')
    expect(reg.listEntries()).toEqual([{ nodeId: 'hub/b', addonId: 'b', capName: 'cap-b' }])
  })

  it('getNodeManifest returns the addons for a node, or undefined when unknown', () => {
    const reg = new HubNodeRegistry()
    reg.registerNode(params('hub/a', [['a', ['cap-a']]]))
    expect(reg.getNodeManifest('hub/a')).toEqual([{ addonId: 'a', capabilities: ['cap-a'] }])
    expect(reg.getNodeManifest('hub/unknown')).toBeUndefined()
  })

  it('listEntries reflects multiple addons on one node', () => {
    const reg = new HubNodeRegistry()
    reg.registerNode(
      params('dev-agent-0', [
        ['x', ['c1']],
        ['y', ['c2', 'c3']],
      ]),
    )
    expect(reg.listEntries()).toHaveLength(3)
  })

  it('stores device-scoped nativeCaps from the manifest (including addonId) and exposes them per node', () => {
    const reg = new HubNodeRegistry()
    reg.registerNode({
      nodeId: 'hub/reolink',
      addons: [{ addonId: 'reolink', capabilities: ['onvif'] }],
      nativeCaps: [
        { capName: 'switch', addonId: 'provider-reolink', deviceIds: [7, 12] },
        { capName: 'ptz', addonId: 'provider-reolink', deviceIds: [7] },
      ],
    })
    expect(reg.getNodeNativeCaps('hub/reolink')).toEqual([
      { capName: 'switch', addonId: 'provider-reolink', deviceIds: [7, 12] },
      { capName: 'ptz', addonId: 'provider-reolink', deviceIds: [7] },
    ])
  })

  it('addonId defaults to empty string when absent (backward compat for older workers)', () => {
    const reg = new HubNodeRegistry()
    // Omit addonId to simulate an older worker that sends the pre-Task-13 payload.
    reg.registerNode({
      nodeId: 'hub/reolink',
      addons: [{ addonId: 'reolink', capabilities: ['onvif'] }],
      nativeCaps: [
        { capName: 'switch', deviceIds: [7] } as {
          capName: string
          addonId: string
          deviceIds: number[]
        },
      ],
    })
    const caps = reg.getNodeNativeCaps('hub/reolink')
    expect(caps?.[0]).toMatchObject({ capName: 'switch', addonId: '', deviceIds: [7] })
  })

  it('a re-handshake REPLACES nativeCaps atomically (idempotent)', () => {
    const reg = new HubNodeRegistry()
    reg.registerNode({
      nodeId: 'hub/reolink',
      addons: [{ addonId: 'reolink', capabilities: ['onvif'] }],
      nativeCaps: [{ capName: 'switch', addonId: 'provider-reolink', deviceIds: [7] }],
    })
    reg.registerNode({
      nodeId: 'hub/reolink',
      addons: [{ addonId: 'reolink', capabilities: ['onvif'] }],
      nativeCaps: [
        { capName: 'switch', addonId: 'provider-reolink', deviceIds: [7, 12, 15] },
        { capName: 'ptz', addonId: 'provider-reolink', deviceIds: [7] },
      ],
    })
    expect(reg.getNodeNativeCaps('hub/reolink')).toEqual([
      { capName: 'switch', addonId: 'provider-reolink', deviceIds: [7, 12, 15] },
      { capName: 'ptz', addonId: 'provider-reolink', deviceIds: [7] },
    ])
  })

  it('listNativeCapEntries gives a flat (nodeId, addonId, capName, deviceId) view across all nodes', () => {
    const reg = new HubNodeRegistry()
    reg.registerNode({
      nodeId: 'hub/reolink',
      addons: [{ addonId: 'reolink', capabilities: ['onvif'] }],
      nativeCaps: [{ capName: 'switch', addonId: 'provider-reolink', deviceIds: [7, 12] }],
    })
    expect(reg.listNativeCapEntries()).toEqual([
      { nodeId: 'hub/reolink', addonId: 'provider-reolink', capName: 'switch', deviceId: 7 },
      { nodeId: 'hub/reolink', addonId: 'provider-reolink', capName: 'switch', deviceId: 12 },
    ])
  })

  it('removeNode drops a node nativeCaps too', () => {
    const reg = new HubNodeRegistry()
    reg.registerNode({
      nodeId: 'hub/reolink',
      addons: [{ addonId: 'reolink', capabilities: ['onvif'] }],
      nativeCaps: [{ addonId: 'reolink', capName: 'switch', deviceIds: [7] }],
    })
    reg.removeNode('hub/reolink')
    expect(reg.getNodeNativeCaps('hub/reolink')).toBeUndefined()
    expect(reg.listNativeCapEntries()).toEqual([])
  })

  it('a node that registers without nativeCaps yields an empty native-cap view', () => {
    const reg = new HubNodeRegistry()
    reg.registerNode(params('hub/a', [['a', ['cap-a']]]))
    expect(reg.getNodeNativeCaps('hub/a')).toEqual([])
    expect(reg.listNativeCapEntries()).toEqual([])
  })

  describe('listNativeCapEntriesForDevice — indexed per-device view', () => {
    const flatForDevice = (reg: HubNodeRegistry, deviceId: number) =>
      reg.listNativeCapEntries().filter((e) => e.deviceId === deviceId)

    it('matches the filtered flat view across multiple nodes + devices', () => {
      const reg = new HubNodeRegistry()
      reg.registerNode({
        nodeId: 'hub/reolink',
        addons: [{ addonId: 'reolink', capabilities: ['onvif'] }],
        nativeCaps: [
          { capName: 'switch', addonId: 'provider-reolink', deviceIds: [7, 12] },
          { capName: 'ptz', addonId: 'provider-reolink', deviceIds: [7] },
        ],
      })
      reg.registerNode({
        nodeId: 'agent-1',
        addons: [{ addonId: 'hikvision', capabilities: ['onvif'] }],
        nativeCaps: [
          { capName: 'motion-zones', addonId: 'provider-hikvision', deviceIds: [7, 99] },
        ],
      })

      // device 7 is served by BOTH nodes — the index must aggregate them.
      expect(reg.listNativeCapEntriesForDevice(7)).toEqual(flatForDevice(reg, 7))
      expect(reg.listNativeCapEntriesForDevice(7)).toHaveLength(3)
      expect(reg.listNativeCapEntriesForDevice(12)).toEqual(flatForDevice(reg, 12))
      expect(reg.listNativeCapEntriesForDevice(99)).toEqual(flatForDevice(reg, 99))
      expect(reg.listNativeCapEntriesForDevice(404)).toEqual([])
    })

    it('a re-handshake REPLACES the node rows (no duplicates, drops gone devices)', () => {
      const reg = new HubNodeRegistry()
      reg.registerNode({
        nodeId: 'hub/reolink',
        addons: [{ addonId: 'reolink', capabilities: ['onvif'] }],
        nativeCaps: [{ capName: 'switch', addonId: 'provider-reolink', deviceIds: [7, 12] }],
      })
      // Re-handshake: device 12 dropped, ptz gained on 7.
      reg.registerNode({
        nodeId: 'hub/reolink',
        addons: [{ addonId: 'reolink', capabilities: ['onvif'] }],
        nativeCaps: [
          { capName: 'switch', addonId: 'provider-reolink', deviceIds: [7] },
          { capName: 'ptz', addonId: 'provider-reolink', deviceIds: [7] },
        ],
      })
      expect(reg.listNativeCapEntriesForDevice(7)).toEqual(flatForDevice(reg, 7))
      expect(reg.listNativeCapEntriesForDevice(7)).toHaveLength(2)
      expect(reg.listNativeCapEntriesForDevice(12)).toEqual([])
    })

    it('removeNode clears that node device rows but leaves other nodes', () => {
      const reg = new HubNodeRegistry()
      reg.registerNode({
        nodeId: 'hub/reolink',
        addons: [{ addonId: 'reolink', capabilities: ['onvif'] }],
        nativeCaps: [{ capName: 'switch', addonId: 'provider-reolink', deviceIds: [7] }],
      })
      reg.registerNode({
        nodeId: 'agent-1',
        addons: [{ addonId: 'hikvision', capabilities: ['onvif'] }],
        nativeCaps: [{ capName: 'motion-zones', addonId: 'provider-hikvision', deviceIds: [7] }],
      })
      reg.removeNode('hub/reolink')
      expect(reg.listNativeCapEntriesForDevice(7)).toEqual(flatForDevice(reg, 7))
      expect(reg.listNativeCapEntriesForDevice(7)).toEqual([
        { nodeId: 'agent-1', addonId: 'provider-hikvision', capName: 'motion-zones', deviceId: 7 },
      ])
    })
  })
})

describe('HubNodeRegistry — rootPackage (runtime-updatable node packages)', () => {
  it('stores the root-package identity from the manifest and exposes it per node', () => {
    const reg = new HubNodeRegistry()
    reg.registerNode({
      ...params('agent-a', [['agent-runtime', ['server-management']]]),
      rootPackage: { name: '@camstack/server', version: '1.1.40' },
    })
    expect(reg.getNodeRootPackage('agent-a')).toEqual({
      name: '@camstack/server',
      version: '1.1.40',
    })
    expect(reg.getNodeRootPackage('unknown-node')).toBeNull()
  })

  it('a re-handshake without rootPackage clears it (atomic replace)', () => {
    const reg = new HubNodeRegistry()
    reg.registerNode({
      ...params('agent-a', [['agent-runtime', ['server-management']]]),
      rootPackage: { name: '@camstack/server', version: '1.1.40' },
    })
    reg.registerNode(params('agent-a', [['agent-runtime', ['server-management']]]))
    expect(reg.getNodeRootPackage('agent-a')).toBeNull()
  })

  it('a re-handshake with a new version replaces the old one', () => {
    const reg = new HubNodeRegistry()
    reg.registerNode({
      ...params('agent-a', [['agent-runtime', ['server-management']]]),
      rootPackage: { name: '@camstack/server', version: '1.1.40' },
    })
    reg.registerNode({
      ...params('agent-a', [['agent-runtime', ['server-management']]]),
      rootPackage: { name: '@camstack/server', version: '1.1.41' },
    })
    expect(reg.getNodeRootPackage('agent-a')).toEqual({
      name: '@camstack/server',
      version: '1.1.41',
    })
  })

  it('removeNode drops the root-package identity too', () => {
    const reg = new HubNodeRegistry()
    reg.registerNode({
      ...params('agent-a', [['agent-runtime', ['server-management']]]),
      rootPackage: { name: '@camstack/server', version: '1.1.40' },
    })
    reg.removeNode('agent-a')
    expect(reg.getNodeRootPackage('agent-a')).toBeNull()
  })
})
