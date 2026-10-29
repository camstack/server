import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { VeluxNode } from '../velux-client-contract.js'
import {
  buildNodeCandidates,
  findNodeByNativeId,
  nodeNativeId,
  rainNativeId,
} from '../velux-discovery.js'
import { VeluxNodeResolver } from '../velux-node-resolver.js'
import { nodeToCoverStatus, nodeToFloodStatus } from '../velux-protocol.js'

const GW = 'velux:192-168-20-65'

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

describe('native ids', () => {
  it('key on the serial so a renumbered node keeps its device', () => {
    expect(nodeNativeId(GW, node({ nodeId: 0 }))).toBe(nodeNativeId(GW, node({ nodeId: 7 })))
    expect(nodeNativeId(GW, node({ serial: '' }))).toBe(`${GW}:node:0`)
  })

  it('finds the node and the kind behind a native id', () => {
    const a = node({ nodeId: 0, serial: 'aa00000000000001' })
    const b = node({
      nodeId: 1,
      serial: 'bb00000000000002',
      name: 'Roller',
      rainSensor: false,
    })
    expect(findNodeByNativeId(GW, [a, b], nodeNativeId(GW, b))).toEqual({
      kind: 'cover',
      node: b,
    })
    expect(findNodeByNativeId(GW, [a, b], rainNativeId(GW, a))).toEqual({
      kind: 'rain',
      node: a,
    })
    expect(findNodeByNativeId(GW, [a, b], `${GW}:serial:cc`)).toBeNull()
  })
})

describe('buildNodeCandidates', () => {
  it('offers one cover per node and a rain sensor only for a window that has one', () => {
    const window = node({ nodeId: 0 })
    const shutter = node({
      nodeId: 1,
      serial: 'bb00000000000002',
      name: 'Roller',
      coverClass: 'shutter',
      rainSensor: false,
    })
    const candidates = buildNodeCandidates({
      gatewayId: GW,
      gatewayName: 'KLF',
      nodes: [window, shutter],
      adoptedDeviceIdByNativeId: { [nodeNativeId(GW, window)]: 51 },
    })
    expect(candidates.map((c) => [c.childNativeId, c.type, c.alreadyAdopted])).toEqual([
      [nodeNativeId(GW, window), DeviceType.Cover, true],
      [rainNativeId(GW, window), DeviceType.Sensor, false],
      [nodeNativeId(GW, shutter), DeviceType.Cover, false],
    ])
    expect(candidates[0]?.adoptedDeviceId).toBe(51)
    expect(candidates[1]?.capabilities).toEqual(['flood'])
    expect(candidates[1]?.name).toBe('Finestra bagno camera rain')
  })

  it('marks an unreachable node offline and names an unnamed node after its class', () => {
    const [candidate] = buildNodeCandidates({
      gatewayId: GW,
      gatewayName: 'KLF',
      nodes: [node({ name: '', online: false, rainSensor: false })],
      adoptedDeviceIdByNativeId: {},
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
    resolver.set(GW, {
      getNodes: () => [moved, bare],
      getNode: () => null,
      client: null,
    })
    expect(resolver.findNode(GW, { serial: 'aa00000000000001', nodeId: 0 })).toBe(moved)
    expect(resolver.findNode(GW, { serial: '', nodeId: 9 })).toBe(bare)
    // a serial-less ref never grabs a node that has a serial
    expect(resolver.findNode(GW, { serial: '', nodeId: 7 })).toBeNull()
  })
})
