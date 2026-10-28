/**
 * System → Notifications → Targets (`/system/notifications?tab=targets`) with an
 * Alexa kind: the "Add target" form with the Echo picker built from the
 * account's devices, and "Find devices" proposing the Echoes that have no
 * target yet. The kind descriptor comes from the addon's own builder, so the
 * form shown is the form the hub would serve.
 */
import { alexaTargetKind } from '../../../../packages/addon-import-alexa/src/speak/provider'
import { ALEXA_ICON_SVG } from '../../../../packages/addon-import-alexa/src/speak/icon-routes'
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

const ACCOUNT = { id: 'alexa_001', name: 'Home', ready: true, devices: SAMPLE_ECHOES }

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

export default defineFixtures({
  area: 'notification-targets',
  description: 'Targets page with an Alexa kind: the Echo picker form and Find devices',
  handlers: {
    'notificationOutput.listTargetKinds': [alexaKind, webhookKind],
    'notificationOutput.listTargets': [
      {
        id: 'alexa-echo-1',
        addonId: 'import-alexa',
        kind: 'alexa-echo',
        name: 'Kitchen',
        enabled: true,
        config: {
          brokerId: 'alexa_001',
          echoId: 'echo-kitchen',
          mode: 'speak',
          volume: 40,
          respectDnd: true,
        },
      },
    ],
    // The provider already skips configured Echoes; the dialog skips them again
    // (a provider that does not), so the fixture answers with all three.
    'notificationOutput.discoverTargets': SAMPLE_ECHOES.map((device) => ({
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
    'userManagement.listUsers': [],
    'auth.listLoginMethods': [],
  },
})
