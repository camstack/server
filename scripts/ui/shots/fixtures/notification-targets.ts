/**
 * System → Notifications → Targets (`/system/notifications?tab=targets`) with an
 * Alexa kind: the "Add target" form with the Echo picker built from the
 * account's devices, and "Find devices" proposing the Echoes that have no
 * target yet. The kind descriptor comes from the addon's own builder, so the
 * form shown is the form the hub would serve.
 */
import { alexaTargetKind } from '../../../../packages/addon-import-alexa/src/speak/provider'
import { ALEXA_ICON_SVG } from '../../../../packages/addon-import-alexa/src/speak/icon-routes'
import { buildEmailDescriptor } from '../../../../packages/addon-notifiers/src/adapters/email'
import { defineFixtures } from './_define'

/** Invented Echo devices. Not a real account. */
const SAMPLE_ECHOES = [
  {
    id: 'echo-kitchen',
    name: 'Kitchen',
    family: 'ECHO',
    online: true,
    kind: 'device' as const,
    dnd: false,
    deviceType: 'A3S5BH2HU6VAYF',
    room: 'Ground floor',
  },
  {
    id: 'echo-hall',
    name: 'Hall',
    family: 'ECHO',
    online: true,
    kind: 'device' as const,
    dnd: true,
    deviceType: 'A3S5BH2HU6VAYF',
  },
  {
    id: 'group-downstairs',
    name: 'Downstairs',
    family: 'WHA',
    online: true,
    kind: 'group' as const,
    dnd: false,
    deviceType: 'A3S5BH2HU6VAYF',
  },
]

const ACCOUNT = {
  id: 'alexa_001',
  name: 'Home',
  ready: true,
  devices: SAMPLE_ECHOES,
}

/** The harness serves no addon route, so the brand mark travels inline. */
const alexaKind = {
  ...alexaTargetKind([ACCOUNT]),
  iconUrl: `data:image/svg+xml,${encodeURIComponent(ALEXA_ICON_SVG)}`,
}

const webhookKind = {
  kind: 'webhook',
  label: 'Webhook',
  icon: 'webhook',
  addonId: 'notifiers',
  supportsDiscovery: false,
  configSchema: {
    sections: [
      {
        id: 'webhook',
        title: 'Webhook',
        fields: [{ type: 'text', key: 'url', label: 'URL' }],
      },
    ],
  },
  caps: alexaKind.caps,
}

/** The Email kind as the hub serves it: one provider, whose relays are discovered. */
const emailKind = buildEmailDescriptor([
  { value: 'provider-smtp', label: 'Email (SMTP) — smtp.example.com', ready: true },
])

/** The targets as instances of `notification-output`, per provider addon (D1013). */
const INSTANCES: Readonly<Record<string, readonly unknown[]>> = {
  notifiers: [
    {
      id: 'email-alerts',
      name: 'Alerts',
      kind: 'notify-email',
      configured: true,
      enabled: true,
      formValues: {
        name: 'Alerts',
        to: 'ops@example.com',
        smtpAddonId: 'provider-smtp',
        smtpInstanceId: 'relay-gone',
        ownerUserId: 'user-1',
      },
    },
  ],
  'import-alexa': [
    {
      id: 'alexa-echo-1',
      name: 'Kitchen',
      kind: 'notify-alexa-echo',
      configured: true,
      enabled: true,
      formValues: {
        name: 'Kitchen',
        brokerId: 'alexa_001',
        echoId: 'echo-kitchen',
        mode: 'speak',
        volume: 40,
        respectDnd: true,
      },
    },
  ],
}

const KINDS_BY_ADDON: Readonly<Record<string, readonly { kind: string; label: string }[]>> = {
  notifiers: [emailKind, webhookKind],
  'import-alexa': [alexaKind],
}

const formOf = (kind: string): unknown =>
  [alexaKind, webhookKind, emailKind].find((k) => k.kind === kind)?.configSchema

export default defineFixtures({
  area: 'notification-targets',
  description:
    'Targets page (InstancesTable over notification-output) with an Alexa kind, a Webhook and an Email target pinned to a missing relay',
  handlers: {
    'notificationOutput.listTargetKinds': [alexaKind, webhookKind, emailKind],
    'capabilities.getCapability': (i: { name: string }) => ({
      name: i.name,
      mode: i.name === 'notification-output' ? 'collection' : 'singleton',
      providers: i.name === 'notification-output' ? ['notifiers', 'import-alexa'] : [i.name],
      activeProvider: i.name === 'notification-output' ? null : i.name,
      disabledProviders: [],
    }),
    'integrationInstances.describe': (i: { addonId: string }) => ({
      role: 'services',
      instanceMode: 'multiple',
      kind: 'target',
      canTest: true,
      mintsId: true,
      kinds: (KINDS_BY_ADDON[i.addonId] ?? []).map((k) => ({
        id: `notify-${k.kind}`,
        label: k.label,
        functionCap: 'notification-output',
        canTest: true,
      })),
    }),
    'integrationInstances.listInstances': (i: { addonId: string }) => INSTANCES[i.addonId] ?? [],
    'integrationInstances.instanceFormSchema': (i: { kind?: string; id: string | null }) => {
      const kind = (i.kind ?? 'notify-email').replace('notify-', '')
      return formOf(kind) ?? { sections: [] }
    },
    'mut:integrationInstances.createInstance': { id: 'new-target' },
    'mut:integrationInstances.updateInstance': { ok: true },
    'mut:integrationInstances.setInstanceEnabled': { ok: true },
    'mut:integrationInstances.deleteInstance': { ok: true },
    'mut:integrationInstances.testInstance': { success: true, status: 'validated' },
    // The provider already skips configured Echoes; the dialog skips them again
    // (a provider that does not), so the fixture answers with all three.
    'notificationOutput.discoverTargets': [
      {
        kind: 'email',
        suggestedName: 'Office relay',
        config: { smtpInstanceId: 'relay-1a2b3c4d' },
      },
      {
        kind: 'email',
        suggestedName: 'Backup relay',
        config: { smtpInstanceId: 'relay-5e6f7a8b' },
      },
      ...SAMPLE_ECHOES.map((device) => ({
        kind: 'alexa-echo',
        suggestedName: device.name,
        config: {
          brokerId: 'alexa_001',
          echoId: device.id,
          mode: 'speak',
          volume: 40,
          respectDnd: true,
          family: device.family,
        },
      })),
    ],
    'broker.list': [
      {
        id: 'alexa_001',
        addonId: 'import-alexa',
        name: 'Home',
        kind: 'alexa',
        status: 'connected',
        info: {},
        lastCheckedAt: null,
      },
      {
        id: 'alexa_002',
        addonId: 'import-alexa',
        name: 'Office',
        kind: 'alexa',
        status: 'connected',
        info: {},
        lastCheckedAt: null,
      },
    ],
    'userManagement.listUsers': [],
    'auth.listLoginMethods': [],
  },
})
