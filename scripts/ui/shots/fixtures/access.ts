/**
 * Identity → Tokens & sessions (`/system/identity?tab=access`) and My access:
 * three users, sessions on several clients, one list of tokens (D892/D895:
 * all-permissions scripts, scoped tokens and 41 view links — some expired,
 * some never used), linked apps, an audit trail.
 * Pseudo-random but seeded, so every run draws the same rows.
 */
import { defineFixtures } from './_define'
import { D, H, MINUTE, NOW } from './_time'

let seed = 7
const rnd = (): number => {
  seed = (seed * 16807) % 2147483647
  return seed / 2147483647
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T
const USER_IDS = ['u-admin', 'u-family', 'u-ops'] as const
const CAMERAS = [101, 102, 103, 104, 105, 106, 107, 108]

/**
 * One user per access shape the role modal renders: an admin, a viewer on
 * every device except one (`family`), no access at all (`ops-bot`) and a
 * viewer on an allow list with features (`guest`).
 */
const SCOPES_BY_USER: Readonly<Record<string, readonly unknown[]>> = {
  'u-family': [{ type: 'viewer', allow: '*', block: [104], features: [] }],
  'u-guest': [
    {
      type: 'viewer',
      allow: [101, 102, 103, 108],
      block: [201],
      features: ['face-assignment', 'scenes'],
    },
  ],
}

const USERS = [
  {
    id: 'u-admin',
    username: 'admin',
    isAdmin: true,
    totpEnabled: true,
    createdAt: Date.UTC(2026, 5, 1),
  },
  {
    id: 'u-family',
    username: 'family',
    isAdmin: false,
    totpEnabled: false,
    createdAt: Date.UTC(2026, 6, 3),
  },
  {
    id: 'u-ops',
    username: 'ops-bot',
    isAdmin: false,
    totpEnabled: false,
    createdAt: Date.UTC(2026, 7, 9),
  },
  {
    id: 'u-guest',
    username: 'guest',
    isAdmin: false,
    totpEnabled: false,
    createdAt: Date.UTC(2026, 8, 12),
  },
].map((u) => ({
  ...u,
  allowedProviders: '*',
  allowedDevices: {},
  scopes: SCOPES_BY_USER[u.id] ?? [],
}))

/** The fleet the role modal's device pickers and preview read. */
const fleetDevice = (
  id: number,
  name: string,
  type: string,
  location: string | null,
  parentDeviceId: number | null = null,
) => ({
  id,
  stableId: `dev-${id}`,
  addonId: 'provider-reolink',
  type,
  name,
  location,
  disabled: false,
  parentDeviceId,
  role: null,
  online: true,
  probed: true,
  features: [],
  isCamera: type === 'camera',
  config: {},
  secretConfigPaths: [],
  metadata: {},
})
const FLEET = [
  fleetDevice(101, 'Front door', 'camera', 'Entrance'),
  fleetDevice(102, 'Driveway', 'camera', 'Garden'),
  fleetDevice(103, 'Backyard', 'camera', 'Garden'),
  fleetDevice(104, 'Garage', 'camera', 'Garage'),
  fleetDevice(105, 'Living room', 'camera', 'Living room'),
  fleetDevice(106, 'Nursery', 'camera', 'Bedroom'),
  fleetDevice(107, 'Side gate', 'camera', 'Garden'),
  fleetDevice(108, 'Porch', 'camera', 'Entrance'),
  fleetDevice(201, 'Front door siren', 'siren', 'Entrance', 101),
  fleetDevice(202, 'Driveway light', 'light', 'Garden', 102),
  fleetDevice(301, 'Garage door', 'switch', 'Garage'),
  fleetDevice(302, 'Hallway sensor', 'sensor', 'Hallway'),
]

const VIEW_LINKS = Array.from({ length: 41 }, (_, i) => {
  const created = NOW - Math.floor(rnd() * 40 * D)
  const ttl = pick([1 * H, 24 * H, 7 * D, 30 * D, null])
  const used = rnd() < 0.45 ? created + Math.floor(rnd() * Math.max(1, NOW - created)) : undefined
  const n = 1 + Math.floor(rnd() * 4)
  const kind = rnd() < 0.6 ? 'grid-view' : 'events-view'
  return {
    id: `sh-${i}`,
    subjectId: pick(USER_IDS.slice(0, 2)),
    label: `${kind === 'grid-view' ? 'Wall' : 'Events'} link ${i + 1}`,
    scopes: [
      {
        type: 'share-view',
        grant: {
          kind,
          deviceIds: CAMERAS.slice(i % 4, (i % 4) + n),
          ...(rnd() < 0.2 ? { talk: true } : {}),
        },
      },
    ],
    createdAt: created,
    expiresAt: ttl === null ? null : created + ttl,
    lastUsedAt: used ?? null,
    revokedAt: null,
  }
})

const UA = {
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  firefoxMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0',
  ios: 'CamStack/1.0.590 CFNetwork/1568.100.1 Darwin/24.0.0',
  chromeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  android: 'okhttp/4.12.0',
}
const session = (
  id: string,
  userId: string,
  method: string,
  client: string,
  ip: string,
  createdAgo: number,
  usedAgo: number,
  current = false,
) => ({
  id,
  userId,
  method,
  refreshable: true,
  createdAt: NOW - createdAgo,
  lastUsedAt: NOW - usedAgo,
  expiresAt: NOW - usedAgo + 30 * D,
  client,
  ip,
  current,
})
const SESSIONS = [
  session('ses-1', 'u-admin', 'password', UA.firefoxMac, '192.0.2.51', 3 * D, 2 * MINUTE, true),
  session('ses-2', 'u-admin', 'passkey', UA.ios, '192.0.2.64', 12 * D, 25 * MINUTE),
  session('ses-3', 'u-admin', 'sso', UA.chromeWin, '203.0.113.24', 6 * D, 2 * D),
  session('ses-4', 'u-family', 'password', UA.safariMac, '192.0.2.77', 20 * D, 4 * H),
  session('ses-5', 'u-family', 'handoff', UA.android, '192.0.2.81', 9 * D, 40 * MINUTE),
  session('ses-6', 'u-family', 'password', UA.ios, '198.51.100.9', 2 * D, 6 * H),
]
const OWN_SESSIONS = [
  session(
    'ses-1',
    'u-admin',
    'password+totp',
    'Firefox on macOS',
    '192.0.2.51',
    3 * D,
    2 * MINUTE,
    true,
  ),
  session(
    'ses-2',
    'u-admin',
    'passkey',
    'CamStack app on iPhone',
    '192.0.2.64',
    12 * D,
    25 * MINUTE,
  ),
  session('ses-3', 'u-admin', 'oidc:authentik', 'Chrome on Windows', '203.0.113.24', 6 * D, 2 * D),
]

const SCOPED_TOKENS = [
  {
    id: 'st-1',
    subjectId: 'u-ops',
    label: 'Home Assistant',
    scopes: [{ type: 'addon', target: 'export-homeassistant', access: ['view', 'control'] }],
    createdAt: NOW - 33 * D,
    expiresAt: NOW + 57 * D,
    lastUsedAt: NOW - 3 * MINUTE,
    revokedAt: null,
  },
  {
    id: 'st-2',
    subjectId: 'u-ops',
    label: 'Backup script',
    scopes: [{ type: 'capability', target: 'backup', access: ['view', 'control'] }],
    createdAt: NOW - 70 * D,
    expiresAt: NOW - 10 * D,
    lastUsedAt: NOW - 12 * D,
    revokedAt: null,
  },
  {
    id: 'st-3',
    subjectId: 'u-family',
    label: 'Kitchen tablet',
    scopes: [{ type: 'device', selector: { kind: 'ids', ids: [101, 106] }, access: ['view'] }],
    createdAt: NOW - 5 * D,
    expiresAt: NOW + 85 * D,
    lastUsedAt: NOW - 50 * MINUTE,
    revokedAt: null,
  },
]

const ADMIN_TOKENS = [
  ['at-1', 'Nightly ops script', 10 * D, 80 * D, 7 * H, null],
  ['at-2', 'Release train', 2 * D, 5 * D, null, null],
  ['at-3', 'Migration (one-off)', 45 * D, -15 * D, 44 * D, null],
  ['at-4', 'Leaked in a gist', 20 * D, 10 * D, 19 * D, 18 * D],
].map(([id, label, createdAgo, expiresIn, usedAgo, revokedAgo]) => ({
  id: String(id),
  subjectId: 'u-admin',
  label: String(label),
  scopes: ['*'],
  createdAt: NOW - Number(createdAgo),
  expiresAt: NOW + Number(expiresIn),
  lastUsedAt: usedAgo === null ? null : NOW - Number(usedAgo),
  revokedAt: revokedAgo === null ? null : NOW - Number(revokedAgo),
}))

/** `auth.listTokens`: every token, one format. */
const TOKENS = [...ADMIN_TOKENS, ...SCOPED_TOKENS, ...VIEW_LINKS]

const OAUTH = [
  {
    id: 'oa-1',
    userId: 'u-admin',
    username: 'admin',
    integrationId: 'export-alexa',
    scopes: [{ type: 'category', target: 'device', access: ['view', 'control'] }],
    createdAt: NOW - 60 * D,
    lastUsedAt: NOW - 20 * MINUTE,
    revokedAt: null,
  },
  {
    id: 'oa-2',
    userId: 'u-family',
    username: 'family',
    integrationId: 'export-google',
    scopes: [{ type: 'device', targets: ['101', '106'], access: ['view'] }],
    createdAt: NOW - 14 * D,
    lastUsedAt: NOW - 3 * D,
    revokedAt: null,
  },
  {
    id: 'oa-3',
    userId: 'u-admin',
    username: 'admin',
    integrationId: 'export-alexa',
    scopes: [{ type: 'category', target: 'device', access: ['view'] }],
    createdAt: NOW - 120 * D,
    lastUsedAt: NOW - 61 * D,
    revokedAt: NOW - 60 * D,
  },
]

const ISSUER = 'https://auth.example.com/application/o/camstack/'
const identities = (userId: string) =>
  userId === 'u-admin'
    ? [
        {
          provider: 'auth-oidc',
          subject: 'a1b2c3d4e5',
          issuer: ISSUER,
          userId,
          label: 'admin@example.com',
          linkedAt: NOW - 18 * D,
        },
      ]
    : userId === 'u-family'
      ? [
          {
            provider: 'auth-oidc',
            subject: '77f0e1aa',
            issuer: ISSUER,
            userId,
            label: 'family@example.com',
            linkedAt: NOW - 4 * D,
          },
        ]
      : []

const AUDIT = [
  {
    id: 'aa1',
    at: NOW - 2 * MINUTE,
    action: 'credentials-revoked',
    userId: 'u-admin',
    ip: '192.0.2.51',
    detail: {
      kind: 'share-link',
      requested: 12,
      revoked: 12,
      skipped: 0,
      ids: 'sh-3,sh-9,sh-14,…',
    },
  },
  {
    id: 'aa2',
    at: NOW - 7 * H,
    action: 'admin-token-used',
    userId: 'u-admin',
    ip: '192.0.2.2',
    detail: {
      tokenId: 'at-1',
      name: 'Nightly ops script',
      path: '/trpc/backup.listRuns',
    },
  },
  {
    id: 'aa3',
    at: NOW - 2 * D,
    action: 'admin-token-created',
    userId: 'u-admin',
    ip: '192.0.2.51',
    detail: { tokenId: 'at-2', name: 'Release train' },
  },
  {
    id: 'aa4',
    at: NOW - 3 * D,
    action: 'second-factor-skipped',
    userId: 'u-family',
    ip: '192.0.2.77',
    detail: { method: 'password', factors: 'totp' },
  },
  {
    id: 'aa5',
    at: NOW - 18 * D,
    action: 'admin-token-revoked',
    userId: 'u-admin',
    ip: '192.0.2.51',
    detail: { tokenId: 'at-4' },
  },
]

export default defineFixtures({
  area: 'access',
  description:
    'Identity → Tokens & sessions and My access: users, sessions, share links, tokens, linked apps, audit',
  handlers: {
    'auth.listLoginMethods': [
      { kind: 'redirect', id: 'auth-oidc', label: 'Authentik', startUrl: '#', stage: 'primary' },
    ],
    'auth.listSessions': SESSIONS,
    'auth.listOwnSessions': OWN_SESSIONS,
    'auth.listOwnDeviceCredentials': [],
    'localNetwork.getConnectionEndpoints': {
      endpoints: [{ baseUrl: 'https://192.0.2.10:4443', kind: 'lan-ipv4', label: 'LAN' }],
    },
    'auth.getOwnTotpStatus': { enabled: true, confirmedAt: Date.UTC(2026, 7, 20) },
    'auth.listOwnPasskeys': [
      {
        credentialId: 'cred-1',
        label: 'MacBook Touch ID',
        createdAt: NOW - 40 * D,
        lastUsedAt: NOW - 3 * D,
        transports: ['internal'],
      },
      {
        credentialId: 'cred-2',
        label: 'iPhone',
        createdAt: NOW - 21 * D,
        lastUsedAt: NOW - 12 * D,
        transports: ['hybrid', 'internal'],
      },
    ],
    'auth.listLinkableProviders': [
      { provider: 'oidc:authentik', label: 'Authentik' },
      { provider: 'oidc:google', label: 'Google' },
    ],
    'auth.listOwnExternalIdentities': [
      {
        provider: 'oidc:authentik',
        subject: 'a1b2c3d4e5',
        label: 'admin@example.com',
        linkedAt: NOW - 18 * D,
        providerLabel: 'Authentik',
        available: true,
      },
    ],
    'auth.listTokens': TOKENS,
    'auth.listAuthAudit': AUDIT,
    'mut:auth.revokeCredentials': (i: { ids: string[] }) => ({ revoked: i.ids, skipped: [] }),
    'userManagement.listUsers': USERS,
    'userManagement.listOauthSessions': OAUTH,
    'userManagement.listExternalIdentities': (i: { userId: string }) => identities(i.userId),
    'deviceManager.listAll': FLEET,
    'auth.previewScope': (i: { isAdmin?: boolean; scopes?: readonly { type?: string }[] }) => {
      const viewer = i.scopes?.some((s) => s.type === 'viewer') === true
      const role = i.isAdmin === true ? 'admin' : viewer ? 'viewer' : 'scoped'
      const count = role === 'admin' ? FLEET.length : viewer ? 5 : 3
      const reach = { all: role === 'admin', deviceCount: count }
      const none = { all: false, deviceCount: 0 }
      return {
        isAdmin: role === 'admin',
        role,
        features: [],
        viewableDeviceCount: count,
        device: { view: reach, create: none, delete: none },
        system: role === 'scoped' ? ['system'] : [],
        capabilities: [],
        addons: [],
      }
    },
  },
})
