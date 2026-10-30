/**
 * Build → Automations tab (`/build?tab=automations`): a list of several
 * automations (enabled, disabled, one that never ran), the editor of the
 * `build` area's automation with run traces that carry values (trigger vars,
 * observed vs expected, an unknown reading, a failed step), and a feeder with a
 * very long value list so the device/value picker is shot with a tall values
 * pane. Reuses the `build` area's devices.
 */
import { generateAutomationBlock } from '../../../../packages/types/src/automation/codegen.ts'
import { defineFixtures } from './_define'
import { MINUTE, NOW } from './_time'
import build from './build'

const RECIPE = (minutes: number) => ({
  when: { kind: 'interval' as const, minutes },
  actions: [
    {
      kind: 'action' as const,
      actionId: 'internal:feed-dog',
      variables: { grams: 30 },
    },
  ],
  runMode: { mode: 'cooldown' as const, minutes: 60 },
})

const block = (
  id: string,
  name: string,
  enabled: boolean,
  minutes: number,
  updatedAgo: number,
) => ({
  id,
  name,
  code: generateAutomationBlock({ name, recipe: RECIPE(minutes) }),
  enabled,
  placement: 'hub',
  createdAt: NOW - 86_400_000,
  updatedAt: NOW - updatedAgo,
  createdBy: 'admin',
  status: enabled ? 'running' : 'stopped',
  lastChangedAt: NOW - updatedAgo,
})

const FIRST = (build.handlers['coreBlocks.list'] as { blocks: readonly unknown[] }).blocks[0]

const BLOCKS = [
  FIRST,
  block('blk-night', 'Lock up for the night', true, 1440, 5 * 3_600_000),
  block('blk-garage', 'Garage light when someone arrives', false, 60, 2 * 86_400_000),
]

const TRACES = [
  {
    runId: 'run-1',
    startedAt: NOW - 20 * MINUTE,
    endedAt: NOW - 20 * MINUTE + 6_000,
    trigger: {
      kind: 'detection',
      outcome: 'pass',
      reason: 'animal seen by Kitchen in Bowl',
      vars: {
        deviceId: 101,
        className: 'animal',
        score: 0.91,
        zones: ['zone-bowl'],
      },
    },
    conditions: [
      {
        path: 'when',
        kind: 'all',
        outcome: 'pass',
        reason: 'all conditions hold',
      },
      {
        path: 'when.0',
        kind: 'device-is',
        outcome: 'pass',
        reason: 'hopperLevel > 10',
        deviceId: 201,
        cap: 'pet-feeder',
        fieldPath: 'hopperLevel',
        operator: 'gt',
        expected: 10,
        observed: 64,
      },
      {
        path: 'when.1',
        kind: 'stationary-present',
        outcome: 'pass',
        reason: 'a stationary subject is present',
        deviceId: 101,
      },
    ],
    steps: [
      {
        path: 'actions.0',
        kind: 'action',
        outcome: 'ok',
        message: 'Feed the dog finished',
        args: { grams: 30 },
      },
    ],
    outcome: 'ran',
    repeat: 1,
    lastAt: NOW - 20 * MINUTE,
  },
  {
    runId: 'run-2',
    startedAt: NOW - 50 * MINUTE,
    endedAt: NOW - 50 * MINUTE,
    trigger: {
      kind: 'interval',
      outcome: 'pass',
      reason: 'every 480 minutes',
      vars: {},
    },
    conditions: [
      {
        path: 'when',
        kind: 'all',
        outcome: 'fail',
        reason: '1 of 2 conditions failed',
      },
      {
        path: 'when.0',
        kind: 'device-is',
        outcome: 'fail',
        reason: 'hopperLevel is unknown',
        deviceId: 201,
        cap: 'pet-feeder',
        fieldPath: 'hopperLevel',
        operator: 'gt',
        expected: 10,
        observed: null,
      },
      {
        path: 'when.1',
        kind: 'stationary-present',
        outcome: 'not-evaluated',
        reason: '',
      },
    ],
    steps: [],
    outcome: 'skipped-conditions',
    repeat: 3,
    lastAt: NOW - 25 * MINUTE,
  },
  {
    runId: 'run-3',
    startedAt: NOW - 3 * 3_600_000,
    endedAt: NOW - 3 * 3_600_000 + 2_000,
    trigger: {
      kind: 'interval',
      outcome: 'pass',
      reason: 'every 480 minutes',
      vars: {},
    },
    conditions: [],
    steps: [
      {
        path: 'actions.0',
        kind: 'action',
        outcome: 'error',
        message: 'Feeder offline',
      },
    ],
    outcome: 'failed',
    repeat: 1,
    lastAt: NOW - 3 * 3_600_000,
  },
]

const LONG_FIELDS = Array.from({ length: 90 }, (_, i) => ({
  path: `schedule${String(i + 1).padStart(2, '0')}Grams`,
  kind: 'number',
}))

export default defineFixtures({
  area: 'build-automations',
  description: 'Build → Automations: list, editor with run values, picker with a long value list',
  handlers: {
    ...build.handlers,
    'coreBlocks.list': { blocks: BLOCKS },
    'coreBlocks.getTraces': (input: { blockId?: string }) => ({
      traces:
        input.blockId === 'blk-feed-dog'
          ? TRACES
          : input.blockId === 'blk-night'
            ? TRACES.slice(0, 1)
            : [],
      lastError: null,
    }),
    'deviceManager.getWireableFields': (input: { deviceId?: number }) =>
      input.deviceId === 201
        ? {
            caps: [
              {
                cap: 'pet-feeder',
                fields: [
                  { path: 'hopperLevel', kind: 'number' },
                  { path: 'feeding', kind: 'boolean' },
                  ...LONG_FIELDS,
                ],
              },
            ],
          }
        : { caps: [] },
  },
})
