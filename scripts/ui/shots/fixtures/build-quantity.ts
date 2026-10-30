/**
 * Build → automation editor with quantity numbers (`/build?tab=automations&block=blk-quantity`):
 * one condition on a bowl mass (stored in kg, picked in g) and a `feed` step
 * whose portion is stored in grams and was picked in ounces. Reuses the
 * `build` area's devices and adds the quantity field to the feeder.
 */
import { generateAutomationBlock } from '../../../../packages/types/src/automation/codegen.ts'
import { defineFixtures } from './_define'
import build from './build'
import { NOW } from './_time'

const RECIPE = {
  triggers: [{ kind: 'interval' as const, minutes: 480 }],
  conditions: {
    kind: 'all' as const,
    children: [
      {
        kind: 'condition' as const,
        deviceId: 201,
        cap: 'pet-feeder',
        fieldPath: 'bowlFood',
        operator: 'lt' as const,
        value: 0.05,
        unit: 'g',
      },
    ],
  },
  actions: [
    {
      kind: 'cap' as const,
      deviceId: 201,
      cap: 'pet-feeder',
      method: 'feed',
      args: { grams: 56.699 },
      argUnits: { grams: 'oz' },
    },
  ],
  runMode: { mode: 'cooldown' as const, minutes: 60 },
}

const BLOCK = {
  id: 'blk-quantity',
  name: 'Top up the bowl',
  code: generateAutomationBlock({ name: 'Top up the bowl', recipe: RECIPE }),
  enabled: true,
  placement: 'hub',
  createdAt: NOW - 86_400_000,
  updatedAt: NOW - 3_600_000,
  createdBy: 'admin',
  status: 'running',
  lastChangedAt: NOW - 3_600_000,
}

export default defineFixtures({
  area: 'build-quantity',
  description: 'Automation editor: a quantity condition and a quantity action arg',
  handlers: {
    ...build.handlers,
    'deviceManager.getWireableFields': (input: { deviceId?: number }) =>
      input.deviceId === 201
        ? {
            caps: [
              {
                cap: 'pet-feeder',
                fields: [
                  { path: 'bowlFood', kind: 'number', quantity: 'mass' },
                  { path: 'feeding', kind: 'boolean' },
                ],
              },
            ],
          }
        : { caps: [] },
    'coreBlocks.list': { blocks: [BLOCK] },
    'coreBlocks.getTraces': { traces: [], lastError: null },
  },
})
