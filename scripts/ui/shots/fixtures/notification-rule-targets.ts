/**
 * System → Notifications → Rules, the rule editor's targets (#483, #487): one
 * rule addressing a phone (ntfy) and a speaker (an Echo that speaks a title
 * only), one rule addressing the speaker alone. The kind catalog declares
 * what each delivers, so the editor shows the union with a hint on the mixed
 * rule, the title alone on the speaker rule, and each selected target expands
 * to its own settings.
 */
import { defineFixtures } from './_define'
import { notificationInstanceHandlers } from './_notification-instances'
import { NOW } from './_time'

const PHONE = 'ntfy-family'
const ECHO = 'echo-kitchen'

function rule(id: string, name: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    name,
    enabled: true,
    delivery: 'immediate',
    conditions: { classes: ['person'] },
    media: { image: 'crop' },
    throttle: { cooldownSec: 60, scope: 'rule-device' },
    priority: 3,
    template: { title: 'Someone at {{device}}', body: 'A {{class}} was seen' },
    createdBy: 'admin',
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 3_600_000,
    disabledTargetIds: [],
    ...extra,
  }
}

const LEVELS_PUSH = [
  { id: 'min', label: 'Min', ordinal: 1 },
  { id: 'default', label: 'Default', ordinal: 3 },
  { id: 'urgent', label: 'Urgent', ordinal: 5 },
]

export default defineFixtures({
  area: 'notification-rule-targets',
  description: 'Rule editor targets: a phone + a title-only speaker, and a speaker-only rule',
  handlers: {
    'notificationRules.listRules': {
      rules: [
        rule('rule-mixed', 'Person at the gate', {
          targets: [{ targetId: PHONE }, { targetId: ECHO }],
          targetOverrides: {
            [ECHO]: {
              template: { title: 'Someone is at the gate' },
              schedule: {
                windows: [{ days: [1, 2, 3, 4, 5], startMinute: 480, endMinute: 1320 }],
              },
            },
          },
        }),
        rule('rule-echo', 'Gate announcement', { targets: [{ targetId: ECHO }] }),
      ],
    },
    'notificationOutput.listTargetKinds': [
      {
        kind: 'ntfy',
        label: 'ntfy',
        icon: 'bell',
        addonId: 'notifiers',
        configSchema: { sections: [] },
        supportsDiscovery: false,
        deliveryParams: [{ key: 'sound', label: 'Sound', type: 'string' }],
        caps: {
          attachments: { mediaTypes: ['image'], mode: 'both', max: 1 },
          actions: 3,
          levels: LEVELS_PUSH,
          format: ['text', 'markdown'],
          clickUrl: true,
          sound: false,
          ttl: false,
          bodyMaxLen: 4096,
        },
      },
      {
        kind: 'alexa-echo',
        label: 'Alexa',
        icon: 'megaphone',
        addonId: 'import-alexa',
        configSchema: { sections: [] },
        supportsDiscovery: true,
        caps: {
          text: { title: true, body: false },
          attachments: { mediaTypes: [], mode: 'url', max: 0 },
          actions: 0,
          levels: [
            { id: 'silent', label: 'Silent', ordinal: 1 },
            { id: 'default', label: 'Announce', ordinal: 3 },
          ],
          format: ['text'],
          clickUrl: false,
          sound: false,
          ttl: false,
          bodyMaxLen: 250,
        },
      },
    ],
    'notificationRules.getConditionCatalog': { catalog: [] },
    'notificationRules.getRuleLastRuns': { runs: [], horizonMs: null },
    'notificationRules.listSnoozes': { snoozes: [] },
    'actions.list': [],
    'auth.listLoginMethods': [],
    'deviceManager.listDeviceIdsByCaps': [],
    'preferences.get': { rows: [] },
    'userManagement.listUsers': [],
    ...notificationInstanceHandlers([
      { id: PHONE, addonId: 'notifiers', kind: 'ntfy', name: 'Family phones', enabled: true },
      {
        id: ECHO,
        addonId: 'import-alexa',
        kind: 'alexa-echo',
        name: 'Kitchen Echo',
        enabled: true,
      },
    ]),
  },
})
