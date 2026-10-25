/**
 * Connectivity -> Brokers for a record-backed broker addon, with a critical
 * "sign in again" alert (`/system/integrations?integration=google-services`).
 */
import { defineFixtures } from './_define'
import { NOW } from './_time'

const BROKER_FIELDS = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    clientId: { type: 'string' },
    clientSecret: { type: 'string', secret: true },
  },
  required: ['name'],
}

const secretView = (brokerId: string) => ({
  $secret: `secret://google-services/row/records%3Abrokers/${brokerId}/clientSecret`,
  v: 1,
  set: true,
})

const BROKERS = [
  {
    id: 'google_001',
    addonId: 'google-services',
    name: 'Home Google',
    kind: 'google',
    status: 'auth-failed',
    info: { accountEmail: 'home@example.com', hasClient: true },
    lastCheckedAt: null,
    error: 'Google session expired - sign in again',
  },
  {
    id: 'google_002',
    addonId: 'google-services',
    name: 'Office Google',
    kind: 'google',
    status: 'connected',
    info: { accountEmail: 'office@example.com', hasClient: true },
    lastCheckedAt: NOW,
    error: null,
  },
]

export default defineFixtures({
  area: 'brokers',
  description:
    'Record-backed broker entries with per-row sign in / sign out, plus a reconnect alert',
  handlers: {
    'alerts.list': [
      {
        id: 'google-broker:google_001',
        category: 'google.broker-reconnect',
        severity: 'critical',
        title: 'Google needs a new sign-in',
        message: 'Home Google needs you to sign in to Google again.',
        read: false,
        status: 'active',
        action: {
          label: 'Sign in again',
          href: '/addon/google-services/oauth/start?brokerId=google_001',
          navigation: 'server',
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    'recordEntries.listEntryKinds': {
      kinds: [
        {
          owner: 'google-services',
          kind: 'brokers',
          title: 'Google accounts',
          nameField: 'name',
          fields: BROKER_FIELDS,
          secretPaths: ['clientSecret'],
          rows: 2,
        },
      ],
    },
    'recordEntries.listEntries': {
      entries: [
        {
          id: 'google_001',
          name: 'Home Google',
          rev: 4,
          updatedAt: NOW - 3600_000,
          data: {
            name: 'Home Google',
            clientId: 'client-a.example.com',
            clientSecret: secretView('google_001'),
          },
        },
        {
          id: 'google_002',
          name: 'Office Google',
          rev: 2,
          updatedAt: NOW - 86_400_000,
          data: {
            name: 'Office Google',
            clientId: 'client-b.example.com',
            clientSecret: secretView('google_002'),
          },
        },
      ],
    },
    'broker.list': BROKERS,
    'broker.listProviders': [
      {
        addonId: 'google-services',
        kinds: [
          {
            kind: 'google',
            label: 'Google',
            interactiveConnectPath: '/addon/google-services/oauth/start?brokerId={{brokerId}}',
            interactiveDisconnectPath:
              '/addon/google-services/oauth/disconnect?brokerId={{brokerId}}',
          },
        ],
      },
    ],
  },
})
