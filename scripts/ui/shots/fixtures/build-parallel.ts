/**
 * Build → Automations editor of an automation that runs several steps
 * at the same time (#500).
 * Open with `--route "/build?tab=automations&block=blk-parallel"`.
 */
import { generateAutomationBlock } from '../../../../packages/types/src/automation/codegen.ts'
import { defineFixtures } from './_define'
import { NOW } from './_time'
import build from './build'

const NAME = 'Leaving home'

const RECIPE = {
  when: { kind: 'manual' as const },
  actions: [
    {
      kind: 'parallel' as const,
      steps: [
        { kind: 'action' as const, actionId: 'internal:shutters-down' },
        { kind: 'action' as const, actionId: 'internal:lights-off' },
        { kind: 'wait' as const, seconds: 30 },
      ],
    },
    { kind: 'action' as const, actionId: 'internal:evening' },
  ],
}

const BLOCK = {
  id: 'blk-parallel',
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
  area: 'build-parallel',
  description: 'Build → Automations editor with a parallel step',
  handlers: {
    ...build.handlers,
    'coreBlocks.list': { blocks: [BLOCK] },
    'coreBlocks.getTraces': { traces: [], lastError: null },
    'schedulers.list': [],
    'auth.listLoginMethods': [],
    'preferences.get': { rows: [] },
  },
})
