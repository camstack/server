/**
 * Logs → Destinations and Connectivity → Email: the `integration-instances` records behind
 * the two lists. Loki holds one record (a secret as a "set" view); the SMTP addon holds two
 * relays, one with a migrated id and one minted by the UI. Providers come from the shell's
 * workspace manifests. Invented data.
 */
import { defineFixtures } from './_define'
import {
  describeNotificationHolder,
  listNotificationHolder,
  type FixtureTarget,
} from './_notification-instances'

const LOKI_FORM = {
  sections: [
    {
      id: 'loki-logging',
      title: 'Loki',
      columns: 2,
      fields: [
        { type: 'text', key: 'url', label: 'Loki URL', default: '' },
        { type: 'text', key: 'job', label: 'Job label', default: 'camstack' },
        { type: 'password', key: 'password', label: 'Password' },
      ],
    },
  ],
}

const SMTP_FORM = {
  sections: [
    {
      id: 'smtp',
      title: 'Relay',
      columns: 2,
      fields: [
        { type: 'text', key: 'host', label: 'Host', default: '' },
        { type: 'number', key: 'port', label: 'Port', default: 587 },
        { type: 'text', key: 'username', label: 'Username', default: '' },
        { type: 'password', key: 'password', label: 'Password' },
      ],
    },
  ],
}

const STATIC_TURN_FORM = {
  sections: [
    {
      id: 'turn',
      title: 'TURN / STUN server',
      columns: 2,
      fields: [
        { type: 'text', key: 'urls', label: 'TURN / STUN URLs', default: '' },
        { type: 'text', key: 'username', label: 'Username', default: '' },
        { type: 'password', key: 'credential', label: 'Credential / password' },
      ],
    },
  ],
}

const CLOUDFLARE_TURN_FORM = {
  sections: [
    {
      id: 'credentials',
      title: 'Cloudflare Credentials',
      columns: 2,
      fields: [
        { type: 'text', key: 'keyId', label: 'TURN Key ID', default: '' },
        { type: 'password', key: 'apiToken', label: 'API Token' },
      ],
    },
  ],
}

const SET = { $secret: 'ref', v: 1, set: true }

const INSTANCES: Readonly<Record<string, readonly unknown[]>> = {
  'loki-logging': [
    {
      id: 'loki-logging',
      name: 'Loki',
      configured: true,
      formValues: {
        url: 'http://loki.example.com:3100',
        job: 'camstack',
        password: SET,
      },
    },
  ],
  'static-turn': [
    {
      id: 'turn-0a1b2c3d',
      name: 'Home coturn',
      configured: true,
      formValues: {
        urls: 'turn:turn.example.com:3478?transport=udp, stun:turn.example.com:3478',
        username: 'camstack',
        credential: SET,
      },
    },
    {
      id: 'inst-5d2e9b10',
      name: 'Office coturn',
      configured: false,
      formValues: { urls: '', username: '' },
    },
  ],
  'cloudflare-turn': [
    {
      id: 'cloudflare-turn',
      name: 'Cloudflare TURN',
      configured: true,
      formValues: { keyId: 'a1b2c3d4e5f6', apiToken: SET },
    },
    {
      id: 'cf-turn-5e6f7a8b',
      name: 'Cloudflare TURN (office)',
      configured: false,
      formValues: { keyId: '' },
    },
  ],
  'smtp-nodemailer': [
    {
      id: 'relay-default',
      name: 'Default relay',
      configured: true,
      formValues: {
        host: 'smtp.example.com',
        port: 587,
        username: 'alerts',
        password: SET,
      },
    },
    {
      id: 'inst-3f9a1c2e',
      name: 'Office relay',
      configured: false,
      formValues: { host: '', port: 587, username: '' },
    },
    {
      id: 'inst-77b0d4aa',
      name: 'Backup relay',
      configured: true,
      enabled: false,
      status: { state: 'error', detail: 'connection refused' },
      formValues: { host: 'backup.example.com', port: 587, username: 'alerts' },
    },
  ],
}

/** A notification target pinned to one SMTP relay: the relay's delete is refused while it names it. */
const TARGETS: readonly FixtureTarget[] = [
  {
    id: 'mail-ops',
    name: 'Mail ops',
    kind: 'email',
    addonId: 'notification-output',
    config: { sendWith: 'inst-3f9a1c2e' },
  },
]

export default defineFixtures({
  area: 'provider-instances',
  description:
    'integration-instances records for Loki (Logs), the SMTP relays (Email) and the TURN servers (Network)',
  handlers: {
    'integrationInstances.describe': (i: { addonId: string }) => {
      if (i.addonId === 'notification-output') return describeNotificationHolder(TARGETS, i.addonId)
      if (i.addonId === 'loki-logging') {
        return { instanceMode: 'single', kind: 'destination', canTest: true }
      }
      if (i.addonId === 'cloudflare-turn') {
        return { instanceMode: 'multiple', kind: 'accounts', canTest: true, mintsId: true }
      }
      if (i.addonId === 'static-turn') {
        return { instanceMode: 'multiple', kind: 'servers', canTest: false }
      }
      return { instanceMode: 'multiple', kind: 'relay', canTest: true }
    },
    'integrationInstances.instanceFormSchema': (i: { addonId: string }) => {
      if (i.addonId === 'loki-logging') return LOKI_FORM
      if (i.addonId === 'cloudflare-turn') return CLOUDFLARE_TURN_FORM
      if (i.addonId === 'static-turn') return STATIC_TURN_FORM
      return SMTP_FORM
    },
    'integrationInstances.listInstances': (i: { addonId: string }) =>
      i.addonId === 'notification-output'
        ? listNotificationHolder(TARGETS, i.addonId)
        : (INSTANCES[i.addonId] ?? []),
    'mut:integrationInstances.createInstance': (i: { id: string }) => ({
      id: i.id,
    }),
    'mut:integrationInstances.updateInstance': { ok: true },
    'mut:integrationInstances.setInstanceEnabled': { ok: true },
    'mut:integrationInstances.deleteInstance': { ok: true },
    'mut:integrationInstances.testInstance': {
      success: true,
      status: 'validated',
    },
  },
})
