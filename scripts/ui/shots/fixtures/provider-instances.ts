/**
 * Logs → Destinations and Connectivity → Email: the `integration-instances` records behind
 * the two lists. Loki holds one record (a secret as a "set" view); the SMTP addon holds two
 * relays, one with a migrated id and one minted by the UI. Providers come from the shell's
 * workspace manifests. Invented data.
 */
import { defineFixtures } from './_define'

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

export default defineFixtures({
  area: 'provider-instances',
  description: 'integration-instances records for Loki (Logs) and the SMTP relays (Email)',
  handlers: {
    'integrationInstances.describe': (i: { addonId: string }) =>
      i.addonId === 'loki-logging'
        ? { instanceMode: 'single', kind: 'destination', canTest: true }
        : { instanceMode: 'multiple', kind: 'relay', canTest: true },
    'integrationInstances.instanceFormSchema': (i: { addonId: string }) =>
      i.addonId === 'loki-logging' ? LOKI_FORM : SMTP_FORM,
    'integrationInstances.listInstances': (i: { addonId: string }) => INSTANCES[i.addonId] ?? [],
    'notificationOutput.listTargets': [
      { name: 'Mail ops', config: { smtpInstanceId: 'inst-3f9a1c2e' } },
    ],
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
