/**
 * Build → Automations editor of an automation whose block steps nest two
 * levels: a choose inside a repeat over devices, and a run that shows the
 * nested rows (#500).
 * Open with `--route "/build?tab=automations&block=blk-nesting"`.
 */
import { generateAutomationBlock } from '../../../../packages/types/src/automation/codegen.ts'
import { defineFixtures } from './_define'
import { NOW } from './_time'
import build from './build'

const NAME = 'Lights off at night, one by one'

const light = (id: number, name: string, stableId: string) => ({
  id,
  stableId,
  addonId: 'provider-homeassistant',
  type: 'light',
  name,
  location: 'Living room',
  disabled: false,
  parentDeviceId: null,
  role: null,
  online: true,
  probed: true,
  features: [],
  isCamera: false,
  config: {},
  secretConfigPaths: [],
  metadata: {},
})

const LIGHTS = [light(301, 'Lamp', 'light.lamp'), light(302, 'Desk', 'light.desk')]

const binding = (capName: string) => ({
  capName,
  kind: 'native' as const,
  providerAddonId: 'provider-homeassistant',
  providerNodeId: 'hub',
  nativeAddonId: 'provider-homeassistant',
})

/** The lamp also dims; the desk light only switches: only the switch commands are common. */
const capsOf = (deviceId: number): readonly string[] =>
  deviceId === 301 ? ['switch', 'brightness'] : deviceId === 302 ? ['switch'] : []

const RECIPE = {
  when: { kind: 'manual' as const },
  actions: [
    {
      kind: 'repeat' as const,
      loop: { by: 'forEach' as const, target: { kind: 'devices' as const, ids: [301, 302] } },
      steps: [
        {
          kind: 'choose' as const,
          branches: [
            {
              if: {
                kind: 'time-is' as const,
                between: {
                  from: { kind: 'clock' as const, hh: 22, mm: 0 },
                  to: { kind: 'clock' as const, hh: 6, mm: 0 },
                },
              },
              steps: [
                {
                  kind: 'command' as const,
                  target: { kind: 'var' as const, name: 'item' },
                  actionId: 'switch.off',
                },
              ],
            },
          ],
          else: [{ kind: 'wait' as const, seconds: 2 }],
        },
        { kind: 'wait' as const, seconds: 1 },
      ],
    },
  ],
}

const RUN_AT = NOW - 20 * 60_000

const TRACES = [
  {
    runId: 'run-1',
    startedAt: RUN_AT,
    endedAt: RUN_AT + 3_000,
    trigger: { kind: 'manual', outcome: 'pass', reason: 'run by hand', path: 'when', vars: {} },
    conditions: [{ path: 'when', kind: 'manual', outcome: 'pass', reason: 'run by hand' }],
    steps: [
      {
        path: 'actions.0',
        kind: 'repeat',
        outcome: 'ok',
        message: 'ran 2 times',
        iterations: 2,
        steps: [
          {
            path: 'actions.0.steps.0',
            kind: 'choose',
            outcome: 'ok',
            branch: 'branches.0',
            steps: [
              { path: 'actions.0.steps.0.branches.0.steps.0', kind: 'command', outcome: 'ok' },
            ],
          },
          { path: 'actions.0.steps.1', kind: 'wait', outcome: 'ok' },
        ],
      },
    ],
    outcome: 'ran',
    repeat: 1,
    lastAt: RUN_AT,
  },
]

const BLOCK = {
  id: 'blk-nesting',
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
  area: 'build-nesting',
  description: 'Build → Automations editor with a choose inside a repeat, and its run',
  handlers: {
    ...build.handlers,
    'deviceManager.listAll': LIGHTS,
    'deviceManager.getDevice': (input: { deviceId?: number }) =>
      LIGHTS.find((d) => d.id === input.deviceId) ?? null,
    'deviceManager.getBindings': (input: { deviceId?: number }) => ({
      deviceId: input.deviceId ?? 0,
      entries: capsOf(input.deviceId ?? 0).map(binding),
    }),
    'deviceManager.getBindingsBatch': (input: { deviceIds?: readonly number[] }) =>
      (input.deviceIds ?? []).map((deviceId) => ({
        deviceId,
        entries: capsOf(deviceId).map(binding),
      })),
    'coreBlocks.list': { blocks: [BLOCK] },
    'coreBlocks.getTraces': { traces: TRACES, lastError: null },
    'schedulers.list': [],
    'auth.listLoginMethods': [],
    'preferences.get': { rows: [] },
  },
})
