/**
 * Build → automation editor with the device-fault rows
 * (`/build?tab=automations&block=blk-fault`): the codes are picked from the
 * device's fault catalog, and a saved code outside it stays as a chip. Reuses the event-trigger area's devices; the
 * doorbell stands in for a gateway that carries the `error` cap.
 */
import { generateAutomationBlock } from '../../../../packages/types/src/automation/codegen.ts'
import { defineFixtures } from './_define'
import { NOW } from './_time'
import eventTrigger from './build-event-trigger'

const RECIPE = {
  when: {
    kind: 'all' as const,
    children: [
      {
        kind: 'device-fault-raised' as const,
        deviceId: 401,
        codes: ['unreachable', 'legacy-vendor-code'],
      },
      { kind: 'device-fault-is' as const, deviceId: 401, codes: [] },
    ],
  },
  actions: [{ kind: 'wait' as const, seconds: 5 }],
  runMode: { mode: 'cooldown' as const, minutes: 60 },
}

const BLOCK = {
  id: 'blk-fault',
  name: 'Gateway recovery',
  code: generateAutomationBlock({ name: 'Gateway recovery', recipe: RECIPE }),
  enabled: true,
  createdAt: NOW - 86_400_000,
  updatedAt: NOW - 3_600_000,
  createdBy: 'admin',
  status: 'running',
  lastChangedAt: NOW - 3_600_000,
}

export default defineFixtures({
  area: 'build-fault-code',
  description: 'Automation editor: the device-fault rows, codes picked from the fault catalog',
  handlers: {
    ...eventTrigger.handlers,
    'schedulers.list': [],
    'template.list': [],
    'auth.listLoginMethods': [],
    'preferences.get': { rows: [] },
    'error.listFaultTypes': {
      types: [
        { code: 'unreachable', label: 'Gateway unreachable', severity: 'error' },
        { code: 'auth-failed', label: 'Gateway login refused', severity: 'error' },
        { code: 'connection-lost', label: 'Gateway session down', severity: 'warning' },
      ],
    },
    'coreBlocks.list': { blocks: [BLOCK] },
    'coreBlocks.getTraces': { traces: [], lastError: null },
  },
})
