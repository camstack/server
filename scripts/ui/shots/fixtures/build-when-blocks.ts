/**
 * Build → Automations editor of an automation whose WHEN holds nested blocks
 * (ALL with an ANY and a NOT inside), so the block headers, their reorder and
 * collapse controls and the Ungroup button are on screen (#482).
 * Open with `--route "/build?tab=automations&block=blk-blocks"`.
 */
import { generateAutomationBlock } from '../../../../packages/types/src/automation/codegen.ts'
import { defineFixtures } from './_define'
import { NOW } from './_time'
import build from './build'

const RECIPE = {
  when: {
    kind: 'all' as const,
    children: [
      { kind: 'interval' as const, minutes: 30 },
      {
        kind: 'any' as const,
        children: [
          {
            kind: 'device-is' as const,
            deviceId: 201,
            cap: 'pet-feeder',
            fieldPath: 'hopperLevel',
            operator: 'gt' as const,
            value: 10,
          },
          {
            kind: 'device-is' as const,
            deviceId: 201,
            cap: 'pet-feeder',
            fieldPath: 'hopperLevel',
            operator: 'lt' as const,
            value: 90,
          },
        ],
      },
      {
        kind: 'not' as const,
        child: {
          kind: 'device-is' as const,
          deviceId: 201,
          cap: 'pet-feeder',
          fieldPath: 'hopperLevel',
          operator: 'eq' as const,
          value: 0,
        },
      },
    ],
  },
  actions: [{ kind: 'wait' as const, seconds: 5 }],
}

const BLOCKS = {
  id: 'blk-blocks',
  name: 'Top up the bowl when the hopper allows it',
  code: generateAutomationBlock({
    name: 'Top up the bowl when the hopper allows it',
    recipe: RECIPE,
  }),
  enabled: true,
  placement: 'hub',
  createdAt: NOW - 86_400_000,
  updatedAt: NOW - 3_600_000,
  createdBy: 'admin',
  status: 'running',
  lastChangedAt: NOW - 3_600_000,
}

export default defineFixtures({
  area: 'build-when-blocks',
  description: 'Build → Automations editor with nested WHEN blocks (ALL / ANY / NOT)',
  handlers: {
    ...build.handlers,
    'coreBlocks.list': { blocks: [BLOCKS] },
    'coreBlocks.getTraces': { traces: [], lastError: null },
    'schedulers.list': [],
    'auth.listLoginMethods': [],
    'preferences.get': { rows: [] },
  },
})
