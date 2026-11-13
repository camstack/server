import { defineFixtures } from './_define'

const TS = Date.parse('2026-01-15T10:00:00Z')

function device(
  address: string,
  type: string,
  name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    address,
    type,
    name,
    rooms: ['Living room'],
    functions: ['Heating'],
    firmware: '1.0.6',
    availableFirmware: null,
    updatable: false,
    rssi: -62,
    rssiPeer: null,
    dutyCycle: null,
    dutyCycleLimited: null,
    lowBattery: false,
    unreach: false,
    configPending: false,
    sabotage: false,
    keyChannels: [],
    ...extra,
  }
}

const DEVICES = [
  device('0001D3C99C1234', 'HmIP-eTRV-2', 'Bedroom radiator', {
    lowBattery: true,
    availableFirmware: '1.0.8',
    updatable: true,
  }),
  device('0001D3C99C5678', 'HmIP-BS2', 'Hall buttons', {
    rooms: ['Hall'],
    functions: ['Light'],
    keyChannels: [
      {
        address: '0001D3C99C5678:1',
        index: '1',
        name: 'Left',
        central: 'off',
        links: [
          {
            receiver: '0001D3C99C5678:4',
            receiverName: 'Hall light',
            receiverDeviceName: 'Hall buttons',
          },
        ],
      },
      { address: '0001D3C99C5678:2', index: '2', name: null, central: 'on', links: [] },
    ],
  }),
  device('NEQ1234567', 'HM-CC-RT-DN', 'Study radiator', { unreach: true, rssi: null }),
]

const ACTIONS: Readonly<Record<string, unknown>> = {
  listCcus: [{ integrationId: 'hm_1', name: 'Casa CCU3', connected: true }],
  ccuOverview: {
    info: {
      version: '3.75.7',
      product: 'ccu3',
      productFamily: 'ccu3',
      platform: null,
      serial: 'EXAMPLE0001',
      hostname: 'ccu3-casa',
    },
    infoError: null,
    interfaces: [
      {
        name: 'HmIP-RF',
        port: 2010,
        info: 'HmIP-RF',
        connected: true,
        dutyCycle: 4,
        firmware: '2.8.6',
        type: 'HmIP',
        gateways: [],
      },
      {
        name: 'BidCos-RF',
        port: 2001,
        info: 'BidCos-RF',
        connected: true,
        dutyCycle: 18,
        firmware: '4.4.18',
        type: 'BidCos',
        gateways: [],
      },
    ],
    interfacesError: null,
  },
  listServiceMessages: {
    messages: [
      {
        id: '4711',
        name: 'Bedroom radiator',
        address: '0001D3C99C1234:0',
        channel: 0,
        type: 'LOWBAT',
        timestamp: TS,
        acknowledgeable: true,
      },
    ],
    error: null,
  },
  listCcuDevices: { devices: DEVICES },
  listCcuLinks: {
    links: [
      {
        sender: {
          address: '0001D3C99C5678:1',
          name: 'Hall key left',
          deviceName: 'Hall buttons',
          deviceType: 'HmIP-BS2',
        },
        receiver: {
          address: '0001D3C99C5678:4',
          name: 'Hall light',
          deviceName: 'Hall buttons',
          deviceType: 'HmIP-BS2',
        },
        name: '',
        description: '',
        profile: { kind: 'switch', short: 'toggle', long: 'off' },
      },
      {
        sender: {
          address: '0001D3C99C5678:2',
          name: null,
          deviceName: 'Hall buttons',
          deviceType: 'HmIP-BS2',
        },
        receiver: {
          address: '0001D3C99C5678:4',
          name: 'Hall light',
          deviceName: 'Hall buttons',
          deviceType: 'HmIP-BS2',
        },
        name: 'Night light',
        description: '',
        profile: { kind: 'custom' },
      },
      {
        sender: {
          address: '000A1D89ABCDEF:1',
          name: null,
          deviceName: 'Kitchen window',
          deviceType: 'HmIP-SWDO',
        },
        receiver: {
          address: '0001D3C99C5678:4',
          name: 'Hall light',
          deviceName: 'Hall buttons',
          deviceType: 'HmIP-BS2',
        },
        name: '',
        description: '',
        profile: null,
      },
    ],
    senders: [
      {
        address: '0001D3C99C5678:1',
        name: 'Hall key left',
        deviceName: 'Hall buttons',
        deviceType: 'HmIP-BS2',
      },
      {
        address: '0001D3C99C5678:2',
        name: null,
        deviceName: 'Hall buttons',
        deviceType: 'HmIP-BS2',
      },
    ],
    receivers: [
      {
        address: '0001D3C99C5678:4',
        name: 'Hall light',
        deviceName: 'Hall buttons',
        deviceType: 'HmIP-BS2',
      },
    ],
    failures: [],
  },
  listCcuRooms: {
    rooms: [
      {
        id: '1234',
        name: 'Hall',
        channels: [
          {
            address: '0001D3C99C5678:1',
            name: 'Hall key left',
            deviceName: 'Hall buttons',
            deviceType: 'HmIP-BS2',
          },
          {
            address: '0001D3C99C5678:4',
            name: 'Hall light',
            deviceName: 'Hall buttons',
            deviceType: 'HmIP-BS2',
          },
        ],
      },
      { id: '1240', name: 'Kitchen', channels: [] },
    ],
    channels: [
      {
        address: '0001D3C99C5678:1',
        name: 'Hall key left',
        deviceName: 'Hall buttons',
        deviceType: 'HmIP-BS2',
      },
      {
        address: '0001D3C99C5678:4',
        name: 'Hall light',
        deviceName: 'Hall buttons',
        deviceType: 'HmIP-BS2',
      },
    ],
  },
  listHeatingGroups: {
    groups: [
      {
        id: 7,
        name: 'Bedroom',
        type: 'hmip.heating.group',
        typeLabel: 'Heating group',
        deviceAddress: 'INT0000001',
        forbidSingleOperation: false,
        members: [
          {
            address: '0001D3C99C1234:1',
            type: 'HEATING_CLIMATECONTROL_TRANSCEIVER',
            deviceName: 'Bedroom radiator',
          },
        ],
      },
    ],
    groupsError: null,
    thermostats: [
      {
        device: '0001D3C99C1234',
        channel: '0001D3C99C1234:1',
        name: 'Bedroom radiator',
        currentTemperature: 19.5,
        targetTemperature: 21,
        mode: 'auto',
        activity: 'heating',
      },
    ],
    candidates: [
      {
        address: '0001D3C99C1234:1',
        type: 'HEATING_CLIMATECONTROL_TRANSCEIVER',
        deviceName: 'Bedroom radiator',
      },
      {
        address: 'NEQ1234567:2',
        type: 'CLIMATECONTROL_RT_TRANSCEIVER',
        deviceName: 'Study radiator',
      },
    ],
  },
  ccuPairingStatus: {
    interfaces: [
      { name: 'BidCos-RF', secondsLeft: 0, supportsSecure: true, error: null },
      { name: 'HmIP-RF', secondsLeft: 42, supportsSecure: false, error: null },
    ],
    error: null,
  },
}

/** The Homematic CCU addon page (`/addon/provider-homematic`): every action answers with invented, deterministic data. */
export default defineFixtures({
  area: 'homematic-ccu',
  description: 'Homematic CCU addon page: overview, devices, links, heating, pairing, settings',
  handlers: {
    'mut:addons.custom': (input: unknown) => {
      const action =
        input !== null && typeof input === 'object' && 'action' in input ? input.action : undefined
      if (typeof action === 'string' && action in ACTIONS) return ACTIONS[action]
      return { ok: true }
    },
  },
})
