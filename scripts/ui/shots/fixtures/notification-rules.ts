/**
 * System → Notifications → Rules (`/system/notifications?tab=rules`): a zone
 * detection rule and a doorbell (sensor) rule, so the rule editor's media
 * section (`&rule=<id>&editTab=notification`) renders for both kinds — the
 * picture selector, the trigger-zone flag, GIF / clip, and a sensor's linked
 * cameras.
 */
import { defineFixtures } from './_define'
import { notificationInstanceHandlers } from './_notification-instances'
import { NOW } from './_time'

const TARGET = 'ntfy-family'

function rule(id: string, name: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    name,
    enabled: true,
    targets: [{ targetId: TARGET }],
    throttle: { cooldownSec: 60, scope: 'rule-device' },
    priority: 3,
    createdBy: 'admin',
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 3_600_000,
    disabledTargetIds: [],
    ...extra,
  }
}

export default defineFixtures({
  area: 'notification-rules',
  description: 'Rule editor media section: a zone detection rule and a doorbell rule',
  handlers: {
    'notificationRules.listRules': {
      rules: [
        rule('rule-door', 'Person at the door', {
          delivery: 'immediate',
          actions: {
            onTrigger: ['internal:siren'],
            buttons: [
              { id: 'open', label: 'Open gate', actionId: 'internal:gate', icon: 'unlock' },
            ],
          },
          conditions: { classes: ['person'], zones: { ids: ['zone-door'] } },
          // The legacy triple rides along so the pre-D897 editor (the 'before' shot) shows the same choice.
          media: {
            image: 'scene-boxes',
            showTriggerZone: true,
            gif: true,
            attach: 'best',
            frame: 'boxed',
          },
        }),
        rule('rule-bell', 'Doorbell pressed', {
          delivery: 'device-event',
          conditions: { sensorKinds: ['doorbell'] },
          media: { image: 'clean' },
        }),
        rule('rule-flood', 'Water leak', {
          delivery: 'device-event',
          conditions: { sensorKinds: ['flood', 'appliance-cycle'] },
          media: { image: 'clean' },
        }),
      ],
    },
    'notificationRules.getConditionCatalog': {
      catalog: [
        {
          id: 'sensorKinds',
          group: 'device',
          label: 'Sensor kinds',
          valueType: 'stringList',
          operator: 'in',
          appliesTo: ['device-event'],
          phase: 'P1',
          description: 'Only these kinds of sensor event.',
        },
        {
          id: 'sensorTransition',
          group: 'device',
          label: 'Notify when',
          valueType: 'sensorTransition',
          options: [
            { value: '', label: 'When it starts and when it finishes' },
            { value: 'raised', label: 'Only when it starts' },
            { value: 'cleared', label: 'Only when it finishes' },
          ],
          operator: 'in',
          appliesTo: ['device-event'],
          phase: 'P2',
          description: 'Fire on one edge of a boolean sensor.',
        },
      ],
    },
    'notificationRules.getRuleLastRuns': { runs: [], horizonMs: null },
    'actions.list': [
      {
        id: 'internal:gate',
        name: 'Open the gate',
        addonId: 'system',
        source: 'internal',
        readOnly: false,
        steps: [{ kind: 'wait', seconds: 1 }],
        variables: [],
        status: { isRunning: false, lastRunAt: null, lastError: null },
      },
      {
        id: 'internal:siren',
        name: 'Sound the siren',
        addonId: 'system',
        source: 'internal',
        readOnly: false,
        steps: [{ kind: 'wait', seconds: 5 }],
        variables: [],
        status: { isRunning: false, lastRunAt: null, lastError: null },
      },
    ],
    'notificationRules.listSnoozes': { snoozes: [] },
    'auth.listLoginMethods': [],
    ...notificationInstanceHandlers([
      {
        id: TARGET,
        addonId: 'notifiers',
        kind: 'ntfy',
        name: 'Family phones',
        enabled: true,
        config: {},
      },
    ]),
  },
})
