/**
 * Build → Automations editor of an automation that runs a command once for
 * each device of a list, aimed at the device of the round (#500).
 * Open with `--route "/build?tab=automations&block=blk-repeat-devices"`.
 */
import { generateAutomationBlock } from '../../../../packages/types/src/automation/codegen.ts'
import { defineFixtures } from './_define'
import { NOW } from './_time'
import build from './build'

const NAME = 'Lights off, one by one'

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
          kind: 'cap' as const,
          deviceId: { $var: 'item' },
          cap: 'switch',
          method: 'setState',
          args: { on: false },
        },
        { kind: 'wait' as const, seconds: 2 },
      ],
    },
  ],
}

const BLOCK = {
  id: 'blk-repeat-devices',
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
  area: 'build-repeat-devices',
  description: 'Build → Automations editor with a command on the device of each round',
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
    'coreBlocks.getTraces': { traces: [], lastError: null },
    'schedulers.list': [],
    'auth.listLoginMethods': [],
    'preferences.get': { rows: [] },
  },
})
