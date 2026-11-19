/**
 * Build → Automations → Runs: what a run detail shows. The `build` area's
 * automation (`blk-feed-dog`) carries three runs, newest first:
 *  - a run that FAILED inside a `choose` step (the real error is on the nested
 *    step, the block step only says "a step of the branch failed"),
 *  - a run that RAN, with a state condition (observed 80 against expected
 *    below 90), one it could not read, and a guarded step,
 *  - a hold episode: the "hold pending" row and the run it became (ONE row).
 *
 * Open with `--route "/build?tab=automations&block=blk-feed-dog"` and the step
 * `--step "click:[data-testid=runs-panel] li:first-child button"`.
 */
import { defineFixtures } from './_define'
import { MINUTE, NOW } from './_time'
import automations from './build-automations'

const ROUTE_ERROR =
  'action internal:cc389609 failed: forward to provider-homeassistant/ha:ha_001:dev:11471ce5-switch.pump refused (source-call-failed): parent could not route child unowned cap call "switch.setState": no provider registered for device-native cap "switch" on device 5329 (binding not yet in LocalChildRegistry)'

const base = {
  repeat: 1,
  trigger: { kind: 'interval', outcome: 'pass' as const, reason: 'every 480 minutes', vars: {} },
}

const TRACES = [
  {
    ...base,
    runId: 'run-hold-pending',
    startedAt: NOW - 70 * MINUTE,
    endedAt: NOW - 70 * MINUTE,
    lastAt: NOW - 70 * MINUTE,
    trigger: {
      kind: 'device-becomes',
      path: 'when.0',
      outcome: 'pass' as const,
      reason: 'hold pending: held for 10 min',
      vars: {},
      hold: { phase: 'pending', ms: 600_000, mode: 'held', since: NOW - 70 * MINUTE },
    },
    conditions: [],
    steps: [],
    outcome: 'skipped-trigger',
  },
  {
    ...base,
    runId: 'run-hold-fired',
    startedAt: NOW - 60 * MINUTE,
    endedAt: NOW - 60 * MINUTE + 1_000,
    lastAt: NOW - 60 * MINUTE,
    trigger: {
      kind: 'device-becomes',
      path: 'when.0',
      outcome: 'pass' as const,
      reason: 'held for 10 min',
      vars: {},
      hold: { phase: 'fired', ms: 600_000, mode: 'held', since: NOW - 70 * MINUTE },
    },
    conditions: [],
    steps: [{ path: 'actions.0', kind: 'action', outcome: 'ok' }],
    outcome: 'ran',
  },
  {
    ...base,
    runId: 'run-conditions',
    startedAt: NOW - 30 * MINUTE,
    endedAt: NOW - 30 * MINUTE + 2_000,
    lastAt: NOW - 30 * MINUTE,
    conditions: [
      { path: 'when', kind: 'all', outcome: 'pass', reason: '' },
      {
        path: 'when.0',
        kind: 'device-is',
        outcome: 'pass',
        reason: 'hopperLevel 80, expected < 90 → pass',
        deviceId: 201,
        cap: 'pet-feeder',
        fieldPath: 'hopperLevel',
        operator: 'lt',
        expected: 90,
        observed: 80,
      },
      {
        path: 'when.1',
        kind: 'device-is',
        outcome: 'fail',
        reason: 'feeding value unknown → fail',
        deviceId: 201,
        cap: 'pet-feeder',
        fieldPath: 'feeding',
        operator: 'eq',
        expected: false,
        observed: null,
      },
    ],
    steps: [
      {
        path: 'actions.0',
        kind: 'action',
        outcome: 'skipped',
        condition: 'false',
        conditionReason: 'hopperLevel 80, expected < 20 → fail',
      },
    ],
    outcome: 'skipped-conditions',
  },
  {
    ...base,
    runId: 'run-failed',
    startedAt: NOW - 10 * MINUTE,
    endedAt: NOW - 10 * MINUTE + 3_000,
    lastAt: NOW - 10 * MINUTE,
    conditions: [],
    steps: [
      {
        path: 'actions.0',
        kind: 'choose',
        outcome: 'error',
        message: 'a step of the branch failed',
        branch: 'branches.0',
        steps: [{ path: 'actions.0.0', kind: 'action', outcome: 'error', message: ROUTE_ERROR }],
      },
    ],
    outcome: 'failed',
  },
]

export default defineFixtures({
  area: 'build-run-detail',
  description:
    'Build → Automations: run detail with conditions, a nested failure and a folded hold',
  handlers: {
    ...automations.handlers,
    'deviceManager.search': {
      items: [],
      nextCursor: null,
      total: 0,
      compatibleTotal: 0,
      fleetTotal: 0,
      hiddenIncompatible: 0,
      facets: { locations: [], integrations: [], types: [] },
      suggested: [],
    },
    'notificationRules.getConditionCatalog': { catalog: [] },
    'coreBlocks.getTraces': () => ({ traces: TRACES, lastError: ROUTE_ERROR }),
  },
})
