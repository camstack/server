/**
 * Build → Automations editor of an automation that uses the flow-control
 * steps: set variables, a conditional stop, a step allowed to fail, and a
 * long wait (#500).
 * Open with `--route "/build?tab=automations&block=blk-flow"`.
 */
import { generateAutomationBlock } from '../../../../packages/types/src/automation/codegen.ts'
import { defineFixtures } from './_define'
import { NOW } from './_time'
import build from './build'

const NAME = 'Evening scene, unless nobody is home'

const RECIPE = {
  when: { kind: 'manual' as const },
  actions: [
    { kind: 'action' as const, actionId: 'internal:evening', continueOnError: true as const },
    {
      kind: 'stop' as const,
      reason: 'nobody is home',
      outcome: 'ok' as const,
      if: {
        kind: 'time-is' as const,
        between: {
          from: { kind: 'clock' as const, hh: 23, mm: 0 },
          to: { kind: 'clock' as const, hh: 6, mm: 0 },
        },
      },
    },
    { kind: 'set' as const, vars: { room: 'living room', level: 40 } },
    { kind: 'wait' as const, seconds: 1800 },
    {
      kind: 'stop' as const,
      reason: 'the {{vars.room}} scene did not hold',
      outcome: 'failed' as const,
    },
  ],
}

const BLOCK = {
  id: 'blk-flow',
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
  area: 'build-flow-control',
  description: 'Build → Automations editor with set, stop, continue-on-error and a long wait',
  handlers: {
    ...build.handlers,
    'coreBlocks.list': { blocks: [BLOCK] },
    'coreBlocks.getTraces': { traces: [], lastError: null },
    'schedulers.list': [],
    'auth.listLoginMethods': [],
    'preferences.get': { rows: [] },
  },
})
