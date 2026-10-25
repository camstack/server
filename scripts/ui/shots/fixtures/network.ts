/**
 * The Network page's Addresses section (`/system/network?section=addresses`):
 * one LAN address, its HTTPS counterpart (D859), the public tunnel and the
 * app link, ticked for the roles each serves. Set
 * `withTwin` to false to reproduce the page as it was before D859.
 */
import { defineFixtures } from './_define'

const LAN = 'http://192.0.2.10:4480'
const LAN_HTTPS = 'https://192.0.2.10:4443'
const TUNNEL = 'https://cams.example.com'
const APP_LINK = 'https://camstack.zentik.app'

const ALL_ROLES = ['appConnections', 'notificationTaps', 'internal', 'publicEndpoint']

const row = (over: Record<string, unknown>) => ({
  label: 'LAN — eth0',
  baseUrl: LAN,
  kind: 'lan-ipv4',
  interfaceKind: 'lan',
  plausible: true,
  plausibleReason: '',
  priority: 0,
  detected: true,
  custom: false,
  flags: [],
  inUse: [],
  eligible: ALL_ROLES,
  ...over,
})

const withTwin = true

const rows = [
  row({
    label: 'CamStack app link',
    baseUrl: APP_LINK,
    kind: 'app-link',
    interfaceKind: 'public',
    priority: -1,
    detected: false,
    inUse: ['notificationTaps'],
    eligible: ['notificationTaps'],
  }),
  row({ inUse: ['appConnections', 'internal'] }),
  ...(withTwin
    ? [
        row({
          label: 'LAN — eth0 (HTTPS)',
          baseUrl: LAN_HTTPS,
          priority: 0.5,
          inUse: ['appConnections'],
        }),
      ]
    : []),
  row({
    label: 'Public tunnel',
    baseUrl: TUNNEL,
    kind: 'public',
    interfaceKind: 'public',
    priority: 100,
    inUse: ['appConnections', 'publicEndpoint'],
  }),
]

export default defineFixtures({
  area: 'network',
  description: 'Network addresses: LAN over http and https, public tunnel, app link',
  handlers: {
    'localNetwork.getAddresses': {
      rows,
      roles: {
        appConnections: {
          flagged: [],
          resolved: rows.filter((r) => r.inUse.includes('appConnections')).map((r) => r.baseUrl),
          source: 'auto',
        },
        notificationTaps: { flagged: null, resolved: APP_LINK, source: 'auto' },
        internal: { flagged: null, resolved: LAN, source: 'auto' },
        publicEndpoint: { flagged: null, resolved: TUNNEL, source: 'auto' },
      },
      appLinkHub: TUNNEL,
      listenerOrigins: [LAN, LAN_HTTPS, TUNNEL],
    },
    'localNetwork.list': {
      probedAt: 1_700_000_000_000,
      interfaces: [
        {
          name: 'eth0',
          family: 'IPv4',
          address: '192.0.2.10',
          cidr: '192.0.2.10/24',
          netmask: '255.255.255.0',
          internal: false,
          mac: '02:00:00:00:00:01',
          kind: 'lan',
          preferred: true,
          plausible: true,
          plausibleReason: '',
        },
      ],
    },
    'localNetwork.getAllowedAddresses': { addresses: ['192.0.2.10'] },
  },
})
