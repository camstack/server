/**
 * Build → Automations editor of an automation whose steps carry an "Only if…"
 * (#472): a guarded wait step with an Otherwise list, next to a plain step.
 * Open with `--route "/build?tab=automations&block=blk-guarded"`.
 */
import { generateAutomationBlock } from '../../../../packages/types/src/automation/codegen.ts'
import { defineFixtures } from './_define'
import { NOW } from './_time'
import build from './build'

const RECIPE = {
  when: { kind: 'interval' as const, minutes: 60 },
  actions: [
    {
      kind: 'wait' as const,
      seconds: 5,
      if: {
        kind: 'all' as const,
        children: [
          {
            kind: 'device-is' as const,
            deviceId: 201,
            cap: 'pet-feeder',
            fieldPath: 'hopperLevel',
            operator: 'gt' as const,
            value: 10,
          },
        ],
      },
      else: [{ kind: 'wait' as const, seconds: 1 }],
    },
    { kind: 'action' as const, actionId: 'internal:feed-dog', variables: { grams: 30 } },
  ],
  runMode: { mode: 'cooldown' as const, minutes: 60 },
}

const GUARDED = {
  id: 'blk-guarded',
  name: 'Feed only when the hopper has food',
  code: generateAutomationBlock({ name: 'Feed only when the hopper has food', recipe: RECIPE }),
  enabled: true,
  placement: 'hub',
  createdAt: NOW - 86_400_000,
  updatedAt: NOW - 3_600_000,
  createdBy: 'admin',
  status: 'running',
  lastChangedAt: NOW - 3_600_000,
}

export default defineFixtures({
  area: 'build-conditional-step',
  description: 'Build → Automations editor with a conditional step (If / Otherwise)',
  handlers: {
    ...build.handlers,
    'coreBlocks.list': { blocks: [GUARDED] },
    'coreBlocks.getTraces': { traces: [], lastError: null },
    'schedulers.list': [],
    'auth.listLoginMethods': [],
    'preferences.get': { rows: [] },
  },
})
