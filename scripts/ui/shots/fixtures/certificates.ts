/**
 * Identity → Certificates (`/system/identity?tab=certificates`) and the
 * "My devices" card on My access: paired phones in every status, the device CA,
 * the HTTPS certificate of three nodes (one uploaded on the hub, one agent
 * without a leaf, one offline) and the cluster certificates with a node that
 * presents an older leaf. Invented data only.
 */
import { defineFixtures } from './_define'
import { D, H, MINUTE, NOW } from './_time'

const USERS = [
  { id: 'u-admin', username: 'admin', isAdmin: true },
  { id: 'u-family', username: 'family', isAdmin: false },
].map((u) => ({
  ...u,
  totpEnabled: false,
  createdAt: Date.UTC(2026, 5, 1),
  allowedProviders: '*',
  allowedDevices: {},
  scopes: [],
}))

const DEVICE = (
  id: string,
  userId: string,
  username: string,
  deviceName: string,
  platform: 'ios' | 'android' | 'web' | 'other',
  over: Record<string, unknown>,
) => ({
  id,
  userId,
  username,
  deviceName,
  platform,
  enrolledVia: 'qr',
  fingerprint: `AB:12:${id.padEnd(8, '0').slice(0, 8)}:9F:00:11:22:33:44:55`,
  issuedAt: NOW - 30 * D,
  expiresAt: NOW + 335 * D,
  lastUsedAt: NOW - 2 * H,
  lastUsedFrom: '192.0.2.41',
  revokedAt: null,
  revokedBy: null,
  status: 'active',
  ...over,
})

const DEVICES = [
  DEVICE('cred-1', 'u-admin', 'admin', "Anna's iPhone", 'ios', {}),
  DEVICE('cred-2', 'u-family', 'family', 'Kitchen tablet', 'android', {
    enrolledVia: 'self',
    lastUsedAt: NOW - 3 * D,
    lastUsedFrom: '198.51.100.7',
  }),
  DEVICE('cred-3', 'u-family', 'family', 'Old Pixel', 'android', {
    issuedAt: NOW - 400 * D,
    expiresAt: NOW - 35 * D,
    lastUsedAt: NOW - 60 * D,
    status: 'expired',
  }),
  DEVICE('cred-4', 'u-admin', 'admin', 'Lost phone', 'ios', {
    lastUsedAt: null,
    lastUsedFrom: null,
    revokedAt: NOW - 5 * D,
    revokedBy: 'admin:u-admin',
    status: 'revoked',
  }),
]

const HASH = (n: string): string =>
  Array.from({ length: 32 }, (_, i) =>
    ((i * 7 + n.length * 13 + n.charCodeAt(i % n.length)) % 256)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase(),
  ).join(':')

const LEAF = (serial: string, notAfter: number, issuedVia: string, status = 'valid') => ({
  serial,
  fingerprintSha256: HASH(serial),
  notBefore: NOW - 300 * D,
  notAfter,
  issuedAt: NOW - 300 * D,
  issuedVia,
  status,
  revokedAt: null,
  revokedReason: null,
})

export default defineFixtures({
  area: 'certificates',
  description:
    'Identity → Certificates and My devices: paired phones, device CA, HTTPS per node, cluster certificates',
  handlers: {
    'auth.listLoginMethods': [],
    'userManagement.listUsers': USERS,
    'deviceCredentials.listDeviceCredentials': DEVICES,
    'deviceCredentials.getDeviceCertificateSettings': { selfEnrollment: 'allowed' },
    'deviceCredentials.getDeviceCaStatus': {
      state: 'ready',
      subject: 'CN=CamStack Device CA',
      fingerprintSha256: HASH('device-ca'),
      validTo: 'Oct 9 09:30:00 2036 GMT',
    },
    'mut:deviceCredentials.startEnrollment': () => ({
      code: 'fixture-code',
      expiresAt: NOW + 10 * MINUTE,
      enrollUrl: 'camstack://enroll?hub=https%3A%2F%2Fhub.example.com&code=fixture-code',
      hubOrigin: 'https://hub.example.com',
      hubOrigins: ['https://hub.example.com'],
    }),
    'auth.listOwnDeviceCredentials': DEVICES.filter((d) => d.userId === 'u-admin'),
    'localNetwork.getTlsStatus': {
      mode: 'uploaded',
      leafFingerprintSha256: HASH('hub-leaf'),
      caFingerprintSha256: null,
      validTo: new Date(NOW + 80 * D).toISOString(),
      sans: ['hub.example.com'],
      caCertPem: null,
      reissueError: null,
      restartRequired: false,
    },
    'certificates.listHttpsCertificates': [
      {
        nodeId: 'hub',
        isHub: true,
        online: true,
        https: {
          kind: 'served',
          status: {
            mode: 'uploaded',
            leafFingerprintSha256: HASH('hub-leaf'),
            caFingerprintSha256: null,
            validTo: new Date(NOW + 80 * D).toISOString(),
            sans: ['hub.example.com', '192.0.2.10'],
            reissueError: null,
            restartRequired: false,
          },
        },
      },
      {
        nodeId: 'agent-garage',
        isHub: false,
        online: true,
        https: {
          kind: 'served',
          status: {
            mode: 'generated',
            leafFingerprintSha256: HASH('agent-leaf'),
            caFingerprintSha256: null,
            validTo: new Date(NOW + 12 * D).toISOString(),
            sans: ['agent-garage', '192.0.2.21'],
            reissueError: null,
            restartRequired: false,
          },
        },
      },
      {
        nodeId: 'agent-attic',
        isHub: false,
        online: true,
        https: {
          kind: 'not-served',
          reason: 'The agent has no certificate yet: the hub has not issued one for it.',
        },
      },
      {
        nodeId: 'agent-shed',
        isHub: false,
        online: false,
        https: {
          kind: 'unreadable',
          reason: 'The node is offline - its certificate cannot be read.',
        },
      },
    ],
    'certificates.getMeshCertificates': {
      ca: {
        state: 'ready',
        subject: 'CN=CamStack Mesh CA',
        fingerprintSha256: HASH('mesh-ca'),
        validTo: 'Oct 9 09:30:00 2035 GMT',
      },
      revokedSerials: ['0A1B2C'],
      registryAvailable: true,
      listener: { state: 'open' },
      nodes: [
        { nodeId: 'hub', online: true, current: null, presentingCurrent: null, history: [] },
        {
          nodeId: 'agent-garage',
          online: true,
          current: LEAF('4F2A9C1D7E3B5A60', NOW + 200 * D, 'renewal'),
          presentingCurrent: true,
          history: [LEAF('3E1B8B0C6D2A4F51', NOW - 5 * D, 'enroll', 'revoked')],
        },
        {
          nodeId: 'agent-attic',
          online: true,
          current: LEAF('9C8B7A6F5E4D3C2B', NOW + 18 * D, 'observed', 'expiring'),
          presentingCurrent: false,
          history: [],
        },
        {
          nodeId: 'agent-shed',
          online: false,
          current: LEAF('1122334455667788', NOW + 150 * D, 'enroll'),
          presentingCurrent: null,
          history: [],
        },
      ],
    },
  },
})
