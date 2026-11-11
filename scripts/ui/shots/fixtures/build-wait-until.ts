/**
 * Build → Automations editor of an automation that waits for a condition
 * under a timeout (#500).
 * Open with `--route "/build?tab=automations&block=blk-wait-until"`.
 */
import { generateAutomationBlock } from '../../../../packages/types/src/automation/codegen.ts'
import { defineFixtures } from './_define'
import { NOW } from './_time'
import build from './build'

const NAME = 'Evening scene, once the clock allows'

const RECIPE = {
  when: { kind: 'manual' as const },
  actions: [
    {
      kind: 'wait-until' as const,
      when: {
        kind: 'time-is' as const,
        between: {
          from: { kind: 'clock' as const, hh: 18, mm: 0 },
          to: { kind: 'clock' as const, hh: 23, mm: 0 },
        },
      },
      timeoutS: 5400,
      onTimeout: 'stop' as const,
    },
    { kind: 'action' as const, actionId: 'internal:evening' },
  ],
}

const BLOCK = {
  id: 'blk-wait-until',
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
  area: 'build-wait-until',
  description: 'Build → Automations editor with a wait-until step',
  handlers: {
    ...build.handlers,
    'coreBlocks.list': { blocks: [BLOCK] },
    'coreBlocks.getTraces': { traces: [], lastError: null },
    'schedulers.list': [],
    'auth.listLoginMethods': [],
    'preferences.get': { rows: [] },
  },
})
