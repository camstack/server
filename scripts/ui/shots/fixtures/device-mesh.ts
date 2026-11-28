/**
 * The Network page's Device networks section (`/system/network?tab=device-mesh`):
 * one invented Thread mesh (a border router, three routers, a sleepy sensor and
 * two end devices, one peer Dominevo did not commission) read through the
 * `device-mesh` capability, with the per-node report of the focused node.
 */
import { defineFixtures } from './_define'
import { NOW, MINUTE } from './_time'

const node = (
  deviceId: number | null,
  nodeKey: string,
  label: string,
  role: string,
  over: Record<string, unknown> = {},
) => ({
  deviceId,
  nodeKey,
  label,
  transport: 'thread',
  role,
  power: role === 'sleepy-end-device' ? 'battery' : 'mains',
  online: true,
  rssi: -60,
  lqi: 220,
  lastReadAt: NOW - 3 * MINUTE,
  ...over,
})

const nodes = [
  node(101, 'br', 'Hall border router', 'border-router', {
    rssi: -48,
    lqi: 255,
  }),
  node(102, 'r1', 'Kitchen plug', 'router', { lqi: 200 }),
  node(103, 'r2', 'Garage plug', 'router', { rssi: -78, lqi: 120 }),
  node(104, 'r3', 'Office lamp', 'router', { lqi: 230 }),
  node(105, 's1', 'Door sensor', 'sleepy-end-device', {
    rssi: -85,
    lqi: 60,
    lastReadAt: NOW - 55 * MINUTE,
  }),
  node(106, 'e1', 'Bedroom switch', 'end-device', { lqi: 180 }),
  node(107, 'e2', 'Cellar light', 'end-device', {
    online: false,
    rssi: null,
    lqi: null,
    lastReadAt: null,
  }),
  node(null, 'p1', 'Neighbour router', 'router', {
    rssi: null,
    lqi: 90,
    lastReadAt: null,
  }),
]

const link = (from: string, to: string, lqi: number | null) => ({
  from,
  to,
  kind: 'neighbor',
  lqi,
  rssi: null,
})

const links = [
  link('br', 'r1', 250),
  link('br', 'r3', 230),
  link('r1', 'r2', 120),
  link('r1', 's1', 60),
  link('r3', 'e1', 180),
  link('r2', 'e2', null),
  link('r2', 'p1', 90),
  link('br', 'r2', 140),
]

const item = (n: (typeof nodes)[number]) => ({
  id: n.deviceId,
  name: n.label,
  type: 'switch',
  location: null,
  integrationId: 'matter',
  integrationLabel: 'Matter',
  online: n.online,
  disabled: false,
  compatible: true,
  values: [],
})

const mesh = nodes.filter((n) => n.deviceId !== null)

export default defineFixtures({
  area: 'device-mesh',
  description: 'one invented Thread mesh read through the device-mesh capability',
  handlers: {
    'capabilities.getCapability': (i: { name: string }) => ({
      name: i.name,
      mode: 'singleton',
      providers: ['matter-broker'],
      activeProvider: 'matter-broker',
      disabledProviders: [],
    }),
    'deviceManager.search': {
      items: mesh.map(item),
      nextCursor: null,
      total: mesh.length,
      compatibleTotal: mesh.length,
      fleetTotal: mesh.length,
      hiddenIncompatible: 0,
      facets: { locations: [], integrations: [], types: [] },
      suggested: [],
      missingIds: [],
    },
    'deviceMesh.getTopology': {
      network: {
        id: '1122334455667788',
        name: 'Casa-Thread',
        technology: 'thread',
        channel: 15,
        panId: 4660,
      },
      readAt: NOW - 3 * MINUTE,
      nodes,
      links,
    },
    'deviceMesh.getNodeDiagnostics': (i: { deviceId: number }) => ({
      deviceId: i.deviceId,
      readAt: NOW - 3 * MINUTE,
      vendor: 'Example',
      product: 'Smart plug',
      hardwareVersion: '1.2',
      softwareVersion: '2.4.1',
      uptimeS: 86400 * 6,
      rebootCount: 2,
      bootReason: null,
      networkFaults: [],
      fabrics: [{ fabricIndex: 1, label: 'Dominevo', vendorId: 4939 }],
      thread: {
        role: 'router',
        rloc16: 0x4400,
        channel: 15,
        panId: 4660,
        extPanId: 'dead00beef00cafe',
        partitionId: 1,
        neighbors: [
          {
            extAddress: '8a2f00aa11bb22cc',
            rloc16: 0x4401,
            lqi: 200,
            averageRssi: -62,
            lastRssi: -60,
            ageS: 12,
            isChild: false,
            fullThreadDevice: true,
          },
          {
            extAddress: '8a2f00aa11bb22cd',
            rloc16: 0x4402,
            lqi: 90,
            averageRssi: -81,
            lastRssi: -80,
            ageS: 40,
            isChild: true,
            fullThreadDevice: false,
          },
        ],
        routes: [
          {
            extAddress: '8a2f00aa11bb22cc',
            rloc16: 0x4400,
            routerId: 17,
            nextHop: 17,
            pathCost: 1,
            lqiIn: 3,
            lqiOut: 3,
            linkEstablished: true,
          },
        ],
      },
      wifi: null,
      ethernet: null,
    }),
  },
})
