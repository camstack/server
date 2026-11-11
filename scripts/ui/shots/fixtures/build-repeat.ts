/**
 * Build → Automations editor of an automation that repeats steps while a
 * condition holds (#500).
 * Open with `--route "/build?tab=automations&block=blk-repeat"`.
 */
import { generateAutomationBlock } from '../../../../packages/types/src/automation/codegen.ts'
import { defineFixtures } from './_define'
import { NOW } from './_time'
import build from './build'

const NAME = 'Remind while the garage is open'

const RECIPE = {
  when: { kind: 'manual' as const },
  actions: [
    {
      kind: 'repeat' as const,
      loop: {
        by: 'while' as const,
        when: {
          kind: 'time-is' as const,
          between: {
            from: { kind: 'clock' as const, hh: 22, mm: 0 },
            to: { kind: 'clock' as const, hh: 6, mm: 0 },
          },
        },
        maxIterations: 6,
        waitS: 600,
      },
      steps: [{ kind: 'action' as const, actionId: 'internal:evening' }],
    },
  ],
}

const BLOCK = {
  id: 'blk-repeat',
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
  area: 'build-repeat',
  description: 'Build → Automations editor with a repeat step',
  handlers: {
    ...build.handlers,
    'coreBlocks.list': { blocks: [BLOCK] },
    'coreBlocks.getTraces': { traces: [], lastError: null },
    'schedulers.list': [],
    'auth.listLoginMethods': [],
    'preferences.get': { rows: [] },
  },
})
