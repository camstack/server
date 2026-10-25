/**
 * System → Notifications → Rules (`/system/notifications?tab=rules`): a zone
 * detection rule and a doorbell (sensor) rule, so the rule editor's media
 * section (`&rule=<id>&editTab=notification`) renders for both kinds — the
 * picture selector, the trigger-zone flag, GIF / clip, and a sensor's linked
 * cameras.
 */
import { defineFixtures } from './_define'
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
      ],
    },
    'notificationRules.getConditionCatalog': { catalog: [] },
    'notificationRules.getRuleLastRuns': { runs: [], horizonMs: null },
    'notificationRules.listSequences': { sequences: [] },
    'notificationRules.listSnoozes': { snoozes: [] },
    'auth.listLoginMethods': [],
    'notificationOutput.listTargets': [
      {
        id: TARGET,
        addonId: 'notifiers',
        kind: 'ntfy',
        name: 'Family phones',
        enabled: true,
        config: {},
      },
    ],
  },
})
