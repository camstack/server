/**
 * Build → Automations editor of an automation gated by a `time-is` window
 * (a button press, only between sunset and 06:00 on weekdays), so the window
 * row's from / to / days fields are on screen (#499).
 * Open with `--route "/build?tab=automations&block=blk-time"`.
 */
import { generateAutomationBlock } from '../../../../packages/types/src/automation/codegen.ts'
import { defineFixtures } from './_define'
import { NOW } from './_time'
import build from './build'

const NAME = 'Hall light on a button press, only at night on weekdays'

const RECIPE = {
  when: {
    kind: 'all' as const,
    children: [
      { kind: 'device-event' as const, category: 'button.pressed' },
      {
        kind: 'time-is' as const,
        between: {
          from: {
            kind: 'sun' as const,
            event: 'sunset' as const,
            offsetMin: -30,
          },
          to: { kind: 'clock' as const, hh: 6, mm: 0 },
        },
        days: ['mon' as const, 'tue' as const, 'wed' as const, 'thu' as const, 'fri' as const],
      },
    ],
  },
  actions: [{ kind: 'wait' as const, seconds: 5 }],
}

const BLOCK = {
  id: 'blk-time',
  name: NAME,
  code: generateAutomationBlock({ name: NAME, recipe: RECIPE }),
  enabled: true,
  placement: 'hub',
  createdAt: NOW - 86_400_000,
  updatedAt: NOW - 3_600_000,
  createdBy: 'admin',
  status: 'running',
  lastChangedAt: NOW - 3_600_000,
}

export default defineFixtures({
  area: 'build-time-window',
  description:
    'Build → Automations editor with a time-is window row (sun start, clock end, weekdays)',
  handlers: {
    ...build.handlers,
    'coreBlocks.list': { blocks: [BLOCK] },
    'coreBlocks.getTraces': { traces: [], lastError: null },
    'schedulers.list': [],
    'auth.listLoginMethods': [],
    'preferences.get': { rows: [] },
    // A site with a zone and NO location: the sun end of the window cannot be placed, and the editor says so.
    'system.getSiteLocation': {
      location: null,
      timeZone: 'Europe/Rome',
      derivationAttemptedAt: null,
      derivationError: null,
    },
  },
})
