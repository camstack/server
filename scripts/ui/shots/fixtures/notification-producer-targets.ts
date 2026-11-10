/**
 * System → Notifications → Rules, the summary / timelapse / calendar-events
 * editors' per-target settings (#487, D1032): a digest addressing a phone
 * (ntfy) and a title-only speaker (Echo), the speaker carrying its own title.
 * Same targets and kind catalog as `notification-rule-targets`.
 */
import { defineFixtures } from './_define'
import base from './notification-rule-targets'
import { NOW } from './_time'

const PHONE = 'ntfy-family'
const ECHO = 'echo-kitchen'

const SCHEDULE = {
  windows: [{ days: [1, 2, 3, 4, 5], startMinute: 0, endMinute: 420 }],
  timezone: 'Europe/Rome',
}

const TARGETS = [{ targetId: PHONE }, { targetId: ECHO }]
const OVERRIDES = {
  [ECHO]: { template: { title: 'Overnight digest ready' }, priority: 3 },
  [PHONE]: { attachment: 'image', priority: 5 },
}

const SUMMARY = {
  id: 'sum-1',
  name: 'Overnight digest',
  enabled: true,
  deviceIds: [],
  window: { kind: 'schedule', schedule: SCHEDULE },
  maxTiles: 9,
  maxAiImages: 6,
  rank: 'importance',
  barrierSeconds: 120,
  targets: TARGETS,
  captions: 'none',
  deliverEmpty: false,
  priority: 3,
  targetOverrides: OVERRIDES,
  createdBy: 'admin',
  createdAt: NOW - 86_400_000,
  updatedAt: NOW - 3_600_000,
  readOnly: false,
}

export default defineFixtures({
  area: 'notification-producer-targets',
  description: 'Summary editor: a phone + a title-only speaker, the speaker with its own title',
  handlers: {
    ...base.handlers,
    'notificationRules.listRules': { rules: [] },
    'notificationRules.getTemplateCatalog': { vars: [] },
    'mut:addons.custom': (input: unknown) => {
      const action =
        input !== null && typeof input === 'object' && 'action' in input ? input.action : undefined
      if (action === 'nc.listSummaryRules') return { rules: [SUMMARY], canAuthor: true }
      if (action === 'nc.listTimelapseRules') return { rules: [] }
      if (action === 'nc.listCalendarEventsRules') return { rules: [], canAuthor: true }
      return { ok: true }
    },
  },
})
