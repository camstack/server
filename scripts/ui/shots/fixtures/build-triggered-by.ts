/**
 * Build → Automations editor of an automation with two trigger rows and one
 * step per trigger: each step's condition is a `triggered-by` row naming the
 * trigger that must have started the run (#499).
 * Open with `--route "/build?tab=automations&block=blk-trig"`.
 */
import { generateAutomationBlock } from '../../../../packages/types/src/automation/codegen.ts'
import { defineFixtures } from './_define'
import { NOW } from './_time'
import build from './build'

const NAME = 'Hall light: on for motion, off for the button'

const RECIPE = {
  when: {
    kind: 'any' as const,
    children: [
      { kind: 'device-event' as const, category: 'motion.on-motion-changed', id: 't1' },
      { kind: 'device-event' as const, category: 'button.pressed', id: 't2' },
    ],
  },
  actions: [
    {
      kind: 'wait' as const,
      seconds: 5,
      if: { kind: 'triggered-by' as const, leafIds: ['t1'] },
    },
    {
      kind: 'wait' as const,
      seconds: 1,
      if: { kind: 'triggered-by' as const, leafIds: ['t2'] },
    },
  ],
}

const BLOCK = {
  id: 'blk-trig',
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
  area: 'build-triggered-by',
  description:
    'Build → Automations editor with two trigger rows and a triggered-by condition per step',
  handlers: {
    ...build.handlers,
    'coreBlocks.list': { blocks: [BLOCK] },
    'coreBlocks.getTraces': { traces: [], lastError: null },
    'schedulers.list': [],
    'auth.listLoginMethods': [],
    'preferences.get': { rows: [] },
  },
})
