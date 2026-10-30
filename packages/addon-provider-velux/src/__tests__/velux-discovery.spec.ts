import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { VeluxNode } from '../velux-client-contract.js'
import {
  buildVeluxCandidates,
  gatewayNativeId,
  nodeNativeId,
  rainNativeId,
  resolveNativeId,
  windowCoverNativeId,
} from '../velux-discovery.js'
import { VeluxNodeResolver, type VeluxNodeSource } from '../velux-node-resolver.js'
import { nodeToCoverStatus, nodeToFloodStatus } from '../velux-protocol.js'

const INT = 'int-7f3a'

function node(overrides: Partial<VeluxNode>): VeluxNode {
  return {
    nodeId: 0,
    serial: 'aa00000000000001',
    name: 'Finestra bagno camera',
    position: 0,
    targetPosition: 0,
    moving: false,
    coverClass: 'window',
    online: true,
    rainSensor: true,
    raining: false,
    ...overrides,
  }
}

const WINDOW_RAIN = node({ nodeId: 0, serial: 'aa00000000000001' })
const WINDOW_PLAIN = node({
  nodeId: 1,
  serial: 'bb00000000000002',
  name: 'Finestra cucina',
  rainSensor: false,
})
const SHUTTER = node({
  nodeId: 2,
  serial: 'cc00000000000003',
  name: 'Tapparella',
  coverClass: 'shutter',
  rainSensor: false,
})

describe('native ids', () => {
  it('key on the serial so a renumbered node keeps its device, and carry the integration', () => {
    expect(nodeNativeId(INT, node({ nodeId: 0 }))).toBe(nodeNativeId(INT, node({ nodeId: 7 })))
    expect(nodeNativeId(INT, node({ serial: '' }))).toBe(`${INT}:node:0`)
    expect(nodeNativeId('other', WINDOW_RAIN)).not.toBe(nodeNativeId(INT, WINDOW_RAIN))
    expect(gatewayNativeId(INT)).toBe(`${INT}:gateway`)
  })

  it('resolves a native id to the gateway, a window with rain or a plain cover', () => {
    const nodes = [WINDOW_RAIN, WINDOW_PLAIN, SHUTTER]
    expect(resolveNativeId(INT, nodes, gatewayNativeId(INT))).toEqual({ kind: 'gateway' })
    expect(resolveNativeId(INT, nodes, nodeNativeId(INT, WINDOW_RAIN))).toEqual({
      kind: 'window',
      node: WINDOW_RAIN,
    })
    expect(resolveNativeId(INT, nodes, nodeNativeId(INT, WINDOW_PLAIN))).toEqual({
      kind: 'cover',
      node: WINDOW_PLAIN,
    })
    expect(resolveNativeId(INT, nodes, nodeNativeId(INT, SHUTTER))).toEqual({
      kind: 'cover',
      node: SHUTTER,
    })
    expect(resolveNativeId(INT, nodes, `${INT}:serial:ff`)).toBeNull()
    // the pieces of a window are not adoptable alone
    expect(resolveNativeId(INT, nodes, rainNativeId(INT, WINDOW_RAIN))).toBeNull()
    expect(resolveNativeId(INT, nodes, windowCoverNativeId(INT, WINDOW_RAIN))).toBeNull()
  })
})

describe('buildVeluxCandidates', () => {
  const candidates = buildVeluxCandidates({
    integrationId: INT,
    integrationName: 'Casa KLF',
    online: true,
    nodes: [WINDOW_RAIN, WINDOW_PLAIN, SHUTTER],
    adopted: new Map([[nodeNativeId(INT, SHUTTER), 51]]),
  })

  it('offers the gateway first, a container for a window with rain, a plain cover for the rest', () => {
    expect(candidates.map((c) => [c.childNativeId, c.type, c.alreadyAdopted])).toEqual([
      [gatewayNativeId(INT), DeviceType.Gateway, false],
      [nodeNativeId(INT, WINDOW_RAIN), DeviceType.Container, false],
      [nodeNativeId(INT, WINDOW_PLAIN), DeviceType.Cover, false],
      [nodeNativeId(INT, SHUTTER), DeviceType.Cover, true],
    ])
    expect(candidates[3]?.adoptedDeviceId).toBe(51)
  })

  it('gives the window container its cover and its rain sensor as children', () => {
    const container = candidates[1]
    expect(container?.name).toBe('Finestra bagno camera')
    expect(
      container?.children?.map((c) => [c.childNativeId, c.type, c.capabilities, c.name]),
    ).toEqual([
      [windowCoverNativeId(INT, WINDOW_RAIN), DeviceType.Cover, ['cover'], 'Finestra bagno camera'],
      [rainNativeId(INT, WINDOW_RAIN), DeviceType.Sensor, ['flood'], 'Finestra bagno camera rain'],
    ])
    // a plain window or shutter has no children at all
    expect(candidates[2]?.children).toBeUndefined()
    expect(candidates[3]?.children).toBeUndefined()
  })

  it('describes the gateway by the actions it really supports', () => {
    const gateway = candidates[0]
    expect(gateway?.name).toBe('Casa KLF')
    expect(gateway?.status).toBe('online')
    expect(gateway?.capabilities).toEqual(['reboot', 'device-admin-link'])
    expect(gateway?.metadata.model).toBe('KLF-200')
  })

  it('still offers the gateway while the session is down, with the nodes as last known', () => {
    const down = buildVeluxCandidates({
      integrationId: INT,
      integrationName: 'Casa KLF',
      online: false,
      nodes: [],
      adopted: new Map(),
    })
    expect(down.map((c) => c.type)).toEqual([DeviceType.Gateway])
    expect(down[0]?.status).toBe('offline')
  })

  it('marks an unreachable node offline and names an unnamed node after its class', () => {
    const [, candidate] = buildVeluxCandidates({
      integrationId: INT,
      integrationName: 'KLF',
      online: true,
      nodes: [node({ name: '', online: false, rainSensor: false })],
      adopted: new Map(),
    })
    expect(candidate?.status).toBe('offline')
    expect(candidate?.name).toBe('KLF — window 0')
  })
})

describe('cover status mapping', () => {
  it('reports position, a moving direction and no tilt', () => {
    const now = 1_000
    expect(nodeToCoverStatus(node({ position: 100, targetPosition: 100 }), now)).toEqual({
      state: 'open',
      position: 100,
      tiltPosition: null,
      lastChangedAt: now,
    })
    expect(nodeToCoverStatus(node({ position: 0, targetPosition: 0 }), now).state).toBe('closed')
    expect(
      nodeToCoverStatus(node({ position: 20, targetPosition: 90, moving: true }), now).state,
    ).toBe('opening')
    expect(
      nodeToCoverStatus(node({ position: 90, targetPosition: 20, moving: true }), now).state,
    ).toBe('closing')
  })

  it('reports an unknown position as stopped with a null position, never closed', () => {
    const status = nodeToCoverStatus(node({ position: null, targetPosition: null }), 5)
    expect(status).toMatchObject({ state: 'stopped', position: null })
  })
})

describe('rain status mapping', () => {
  it('flooded mirrors raining and keeps the last change time when nothing changed', () => {
    expect(
      nodeToFloodStatus(node({ raining: true }), { flooded: false, lastChangedAt: 10 }, 99),
    ).toEqual({
      flooded: true,
      lastChangedAt: 99,
    })
    expect(
      nodeToFloodStatus(node({ raining: true }), { flooded: true, lastChangedAt: 10 }, 99),
    ).toEqual({
      flooded: true,
      lastChangedAt: 10,
    })
  })

  it('keeps the prior level when rain is unknown', () => {
    expect(
      nodeToFloodStatus(node({ raining: null }), { flooded: true, lastChangedAt: 10 }, 99),
    ).toEqual({
      flooded: true,
      lastChangedAt: 10,
    })
  })
})

describe('VeluxNodeResolver.findNode', () => {
  it('resolves by serial when the node was renumbered', () => {
    const resolver = new VeluxNodeResolver()
    const moved = node({ nodeId: 7, serial: 'aa00000000000001' })
    const bare = node({ nodeId: 9, serial: '', name: 'No serial' })
    const source: VeluxNodeSource = {
      getNodes: () => [moved, bare],
      getNode: () => null,
      getConnection: () => ({ host: '10.0.0.5', password: 'x' }),
      status: 'connected',
      firmware: null,
      client: null,
    }
    resolver.set(INT, source)
    expect(resolver.findNode(INT, { serial: 'aa00000000000001', nodeId: 0 })).toBe(moved)
    expect(resolver.findNode(INT, { serial: '', nodeId: 9 })).toBe(bare)
    // a serial-less ref never grabs a node that has a serial
    expect(resolver.findNode(INT, { serial: '', nodeId: 7 })).toBeNull()
  })
})
