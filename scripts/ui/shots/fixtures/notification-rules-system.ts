/**
 * System → Notifications → Rules, a system-event rule opened on its Conditions
 * tab (`&rule=rule-sys&editTab=conditions`): the Delivery control — when the
 * rule speaks (starts / clears / schedule) and the summary grouping.
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
  area: 'notification-rules-system',
  description: 'Rule editor Conditions tab of a system-event rule with a scheduled summary',
  handlers: {
    'notificationRules.listRules': {
      rules: [
        rule('rule-sys', 'Evening summary', {
          delivery: 'system-event',
          media: { image: 'clean' },
          conditions: {
            systemEvent: {
              kinds: ['device-offline', 'device-battery-low', 'device-consumable-low'],
            },
          },
          systemEventDelivery: {
            mode: 'summary',
            split: 'section',
            schedule: {
              windows: [
                {
                  days: [0, 1, 2, 3, 4, 5, 6],
                  startMinute: 1079,
                  endMinute: 1080,
                },
              ],
            },
          },
        }),
      ],
    },
    'notificationRules.getConditionCatalog': { catalog: [] },
    'notificationRules.getRuleLastRuns': { runs: [], horizonMs: null },
    'notificationRules.listSequences': { sequences: [] },
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
