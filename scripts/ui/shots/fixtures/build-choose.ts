/**
 * Build → Automations editor of an automation with a `choose` step: two
 * branches and an "otherwise" list (#500).
 * Open with `--route "/build?tab=automations&block=blk-choose"`.
 */
import { generateAutomationBlock } from '../../../../packages/types/src/automation/codegen.ts'
import { defineFixtures } from './_define'
import { NOW } from './_time'
import build from './build'

const NAME = 'Doorbell: night, evening or day'

const window = (fromH: number, toH: number) => ({
  kind: 'time-is' as const,
  between: {
    from: { kind: 'clock' as const, hh: fromH, mm: 0 },
    to: { kind: 'clock' as const, hh: toH, mm: 0 },
  },
})

const RECIPE = {
  when: { kind: 'manual' as const },
  actions: [
    {
      kind: 'choose' as const,
      branches: [
        {
          if: window(23, 6),
          steps: [
            { kind: 'stop' as const, reason: 'night: nobody is disturbed', outcome: 'ok' as const },
          ],
        },
        {
          if: window(18, 23),
          steps: [
            { kind: 'set' as const, vars: { level: 30 } },
            { kind: 'action' as const, actionId: 'internal:evening' },
          ],
        },
      ],
      else: [{ kind: 'wait' as const, seconds: 10 }],
    },
  ],
}

const BLOCK = {
  id: 'blk-choose',
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
  area: 'build-choose',
  description: 'Build → Automations editor with a choose step: two branches and an otherwise list',
  handlers: {
    ...build.handlers,
    'coreBlocks.list': { blocks: [BLOCK] },
    'coreBlocks.getTraces': { traces: [], lastError: null },
    'schedulers.list': [],
    'auth.listLoginMethods': [],
    'preferences.get': { rows: [] },
  },
})
