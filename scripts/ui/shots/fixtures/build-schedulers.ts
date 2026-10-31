/**
 * Build page, Schedulers tab: the list (`/build?tab=schedulers`) and the editor
 * (`/build?tab=schedulers&scheduler=sch-garden`). One scheduler with two
 * profiles (weekdays, weekend) holding garden lights from sunset to 23:00, one
 * paused by its own condition, plus a few ledger traces. Site in Rome.
 */
import { defineFixtures } from './_define'
import build from './build'
import { MINUTE, NOW } from './_time'

const LIGHT_ON = {
  kind: 'cap',
  actionId: 'switch.on',
  target: { kind: 'devices', ids: [201] },
  cap: 'switch',
  method: 'setState',
  args: { on: true },
}
const LIGHT_OFF = { ...LIGHT_ON, actionId: 'switch.off', args: { on: false } }

const GARDEN = {
  id: 'sch-garden',
  name: 'Garden lights',
  enabled: true,
  priority: 10,
  maxLateMs: 10 * MINUTE,
  createdAt: NOW - 3 * 86_400_000,
  updatedAt: NOW - 2 * 3_600_000,
  profiles: [
    {
      id: 'weekdays',
      name: 'Weekdays',
      enabled: true,
      days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      points: [
        {
          id: 'dusk-on',
          at: { kind: 'sun', event: 'sunset', offsetMin: -20 },
          mode: 'hold',
          steps: [LIGHT_ON],
          override: { mode: 'reassert', graceMs: 10 * MINUTE },
        },
        {
          id: 'late-off',
          at: { kind: 'clock', hh: 23, mm: 0 },
          mode: 'edge',
          steps: [LIGHT_OFF],
        },
        {
          id: 'morning-release',
          at: { kind: 'clock', hh: 6, mm: 30 },
          mode: 'release',
          steps: [],
        },
      ],
    },
    {
      id: 'weekend',
      name: 'Weekend',
      enabled: true,
      days: ['sat', 'sun'],
      points: [
        {
          id: 'we-on',
          at: { kind: 'clock', hh: 19, mm: 0 },
          mode: 'hold',
          steps: [LIGHT_ON],
        },
        {
          id: 'we-off',
          at: { kind: 'clock', hh: 0, mm: 30 },
          mode: 'release',
          steps: [],
        },
      ],
    },
  ],
}

const HEATING = {
  id: 'sch-heating',
  name: 'Night heating',
  enabled: false,
  priority: 0,
  maxLateMs: 10 * MINUTE,
  createdAt: NOW - 9 * 86_400_000,
  updatedAt: NOW - 86_400_000,
  profiles: [
    {
      id: 'every-day',
      name: 'Every day',
      enabled: true,
      days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
      points: [
        {
          id: 'warm',
          at: { kind: 'clock', hh: 5, mm: 30 },
          mode: 'edge',
          steps: [LIGHT_ON],
        },
      ],
    },
  ],
}

const trace = (id: string, ago: number, scheduler: string, outcome: string, reason: string) => ({
  runId: id,
  startedAt: NOW - ago,
  endedAt: NOW - ago + 2_000,
  trigger: { kind: 'schedule', outcome: 'pass', reason, vars: {} },
  conditions: [],
  steps: [],
  outcome,
  repeat: 1,
  lastAt: NOW - ago,
  scheduler,
})

export default defineFixtures({
  area: 'build-schedulers',
  description: 'Build page: Schedulers tab, list and editor',
  handlers: {
    ...build.handlers,
    'schedulers.list': [GARDEN, HEATING],
    'schedulers.getStatus': [
      {
        schedulerId: 'sch-garden',
        profileId: 'weekdays',
        hold: {
          pointId: 'dusk-on',
          until: NOW + 90 * MINUTE,
          suspendedInactive: false,
          targets: [
            {
              deviceId: 201,
              cap: 'switch',
              field: 'on',
              status: 'held',
              attempts: 1,
            },
          ],
        },
      },
    ],
    'schedulers.getTraces': {
      traces: [
        trace('t-3', 3 * 60 * MINUTE, 'done', 'ran', 'late-off at 23:00'),
        trace('t-2', 90 * MINUTE, 'held', 'ran', 'dusk-on held until 23:00'),
        trace('t-1', 30 * MINUTE, 'overridden', 'skipped-conditions', 'dusk-on changed by hand'),
      ],
    },
    'schedulers.conflicts': { conflicts: [] },
    'system.getSiteLocation': {
      location: { latitude: 41.9, longitude: 12.5 },
      timeZone: 'Europe/Rome',
      derivationAttemptedAt: null,
      derivationError: null,
    },
    'mut:schedulers.setEnabled': (input: unknown) => input,
  },
})
