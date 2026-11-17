/**
 * System → Notifications → Rules (`/system/notifications?tab=rules`): a zone
 * detection rule and a doorbell (sensor) rule, so the rule editor's media
 * section (`&rule=<id>&editTab=notification`) renders for both kinds — the
 * picture selector, the trigger-zone flag, GIF / clip, and a sensor's linked
 * cameras. Rules of every kind carry tags (D1054) — a summary, a timelapse and
 * a calendar-events rule beside the event rules — and one does not, so the All
 * view's Type column, the tag filter and the by-tag grouping render.
 */
import { defineFixtures } from './_define'
import { notificationInstanceHandlers } from './_notification-instances'
import { tagHandlers } from './_tags'
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

const SCHEDULE = {
  windows: [{ days: [1, 2, 3, 4, 5], startMinute: 0, endMinute: 420 }],
  timezone: 'Europe/Rome',
}

const PRODUCER_BASE = {
  enabled: true,
  targets: [{ targetId: TARGET }],
  priority: 3,
  createdBy: 'admin',
  createdAt: NOW - 86_400_000,
  updatedAt: NOW - 3_600_000,
  readOnly: false,
}

const SUMMARY = {
  ...PRODUCER_BASE,
  id: 'sum-night',
  name: 'Overnight digest',
  deviceIds: [],
  window: { kind: 'schedule', schedule: SCHEDULE },
  maxTiles: 9,
  maxAiImages: 6,
  rank: 'importance',
  barrierSeconds: 120,
  captions: 'none',
  deliverEmpty: false,
  tags: ['Night'],
}

const TIMELAPSE = {
  ...PRODUCER_BASE,
  id: 'tl-garden',
  name: 'Garden timelapse',
  deviceIds: [101],
  schedule: SCHEDULE,
  cadenceSec: 30,
  framerate: 12,
  previewMode: 'image',
  tags: ['Garden'],
}

const CALENDAR = {
  ...PRODUCER_BASE,
  id: 'cal-week',
  name: 'Week ahead',
  schedule: SCHEDULE,
  horizonDays: 7,
  deliverEmpty: false,
  tags: ['Garden'],
}

export default defineFixtures({
  area: 'notification-rules',
  description: 'Rule editor media section: a zone detection rule and a doorbell rule',
  handlers: {
    'notificationRules.listRules': {
      rules: [
        rule('rule-door', 'Person at the door', {
          delivery: 'immediate',
          tags: ['Garden', 'Night'],
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
          tags: ['Garden'],
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
    'mut:addons.custom': (input: unknown) => {
      const action =
        input !== null && typeof input === 'object' && 'action' in input ? input.action : undefined
      if (action === 'nc.listSummaryRules') return { rules: [SUMMARY], canAuthor: true }
      if (action === 'nc.listTimelapseRules') return { rules: [TIMELAPSE] }
      if (action === 'nc.listCalendarEventsRules') return { rules: [CALENDAR], canAuthor: true }
      return { ok: true }
    },
    ...tagHandlers,
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
