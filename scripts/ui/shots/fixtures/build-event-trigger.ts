/**
 * Build → Automations editor with two device-event triggers: a doorbell (its
 * caps declare events) and a lamp (declares none, so the picker says so).
 * Open with `--route "/build?tab=automations&block=blk-event-trigger"`.
 */
import { generateAutomationBlock } from '../../../../packages/types/src/automation/codegen.ts'
import { defineFixtures } from './_define'
import { NOW } from './_time'
import build from './build'

const NAME = 'Doorbell rings, lamp reports'

const device = (id: number, name: string, type: string, stableId: string) => ({
  id,
  stableId,
  addonId: 'provider-homeassistant',
  type,
  name,
  location: 'Hall',
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

const DEVICES = [
  device(401, 'Front doorbell', 'doorbell', 'doorbell.front'),
  device(402, 'Hall lamp', 'light', 'light.hall'),
]

const binding = (capName: string) => ({
  capName,
  kind: 'native' as const,
  providerAddonId: 'provider-homeassistant',
  providerNodeId: 'hub',
  nativeAddonId: 'provider-homeassistant',
})

const capsOf = (deviceId: number): readonly string[] =>
  deviceId === 401 ? ['doorbell', 'battery'] : deviceId === 402 ? ['switch'] : []

function searchItem(row: (typeof DEVICES)[number]) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    location: row.location,
    integrationId: 'provider-homeassistant',
    integrationLabel: 'Home Assistant',
    online: true,
    disabled: false,
    compatible: true,
    values: [],
  }
}

const RECIPE = {
  when: {
    kind: 'any' as const,
    children: [
      { kind: 'device-event' as const, category: 'doorbell.onPressed', deviceId: 401, id: 't1' },
      {
        kind: 'device-event' as const,
        category: 'motion.on-motion-changed',
        deviceId: 402,
        id: 't2',
      },
    ],
  },
  actions: [{ kind: 'wait' as const, seconds: 1 }],
}

const BLOCK = {
  id: 'blk-event-trigger',
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
  area: 'build-event-trigger',
  description: 'Build → Automations editor with device-event triggers on a doorbell and a lamp',
  handlers: {
    ...build.handlers,
    'deviceManager.listAll': DEVICES,
    'deviceManager.search': (input: { ids?: number[]; text?: string }) => {
      const text = (input.text ?? '').toLowerCase()
      const items = DEVICES.filter((row) => {
        if (input.ids !== undefined && !input.ids.includes(row.id)) return false
        return row.name.toLowerCase().includes(text)
      }).map(searchItem)
      return {
        items,
        nextCursor: null,
        total: items.length,
        compatibleTotal: items.length,
        fleetTotal: DEVICES.length,
        hiddenIncompatible: 0,
        facets: { locations: [], integrations: [], types: [] },
        suggested: [],
        missingIds: (input.ids ?? []).filter((id) => !DEVICES.some((row) => row.id === id)),
      }
    },
    'deviceManager.getDevice': (input: { deviceId?: number }) =>
      DEVICES.find((d) => d.id === input.deviceId) ?? null,
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
