/**
 * Build page: the Actions tab (`/build?tab=actions`), the automation editor
 * (`/build?tab=automations&block=blk-feed-dog`) and the camera Linked actions
 * card. Two cameras, a pet feeder, one automation (a detection trigger, an
 * interval trigger, an `action` step, a cooldown), three actions (two internal,
 * one declared by an addon) and a few run traces.
 */
import { generateAutomationBlock } from '../../../../packages/types/src/automation/codegen.ts'
import { defineFixtures } from './_define'
import { MINUTE, NOW } from './_time'

const device = (
  id: number,
  name: string,
  stableId: string,
  type: string,
  isCamera: boolean,
  location: string,
  integrationId?: string,
) => ({
  id,
  stableId,
  addonId: isCamera ? 'provider-reolink' : 'provider-homeassistant',
  type,
  name,
  location,
  disabled: false,
  parentDeviceId: null,
  role: null,
  online: true,
  probed: true,
  features: [],
  isCamera,
  config: {},
  secretConfigPaths: [],
  metadata: {},
  ...(integrationId === undefined ? {} : { integrationId }),
})

const KITCHEN = device(101, 'Kitchen', 'cam.kitchen', 'camera', true, 'Kitchen')
const GARAGE = device(102, 'Garage', 'cam.garage', 'camera', true, 'Garage')
const FEEDER = device(201, 'FRESHELEMENT 3', 'feeder.dog', 'pet-feeder', false, 'Kitchen', 'int-ha')

const RECIPE = {
  triggers: [
    {
      kind: 'detection' as const,
      classes: ['animal'],
      deviceIds: [101],
      zones: ['zone-bowl'],
    },
    { kind: 'interval' as const, minutes: 480 },
    {
      kind: 'device-state' as const,
      deviceId: 201,
      cap: 'pet-feeder',
      fieldPath: 'hopperLevel',
    },
    { kind: 'device-event' as const, category: 'system.boot', deviceId: 101 },
    {
      kind: 'stationary' as const,
      deviceIds: [101],
      phase: 'appeared' as const,
    },
  ],
  conditions: {
    kind: 'all' as const,
    children: [
      {
        kind: 'condition' as const,
        deviceId: 201,
        cap: 'pet-feeder',
        fieldPath: 'hopperLevel',
        operator: 'gt' as const,
        value: 10,
      },
      { kind: 'stationary-present' as const, deviceId: 101 },
    ],
  },
  actions: [
    {
      kind: 'action' as const,
      actionId: 'internal:feed-dog',
      variables: { grams: 30 },
    },
  ],
  runMode: { mode: 'cooldown' as const, minutes: 60 },
}

const BLOCK = {
  id: 'blk-feed-dog',
  name: 'Feed the dog',
  code: generateAutomationBlock({ name: 'Feed the dog', recipe: RECIPE }),
  enabled: true,
  placement: 'hub',
  createdAt: NOW - 86_400_000,
  updatedAt: NOW - 3_600_000,
  createdBy: 'admin',
  status: 'running',
  lastChangedAt: NOW - 3_600_000,
}

export const ACTIONS = [
  {
    id: 'internal:feed-dog',
    name: 'Feed the dog',
    addonId: 'core-blocks',
    source: 'internal',
    readOnly: false,
    steps: [
      {
        kind: 'cap',
        deviceId: 201,
        cap: 'pet-feeder',
        method: 'feed',
        args: { grams: { $var: 'grams' } },
      },
      { kind: 'wait', seconds: 5 },
    ],
    variables: [{ name: 'grams', label: 'Portion (g)', type: 'number', default: 30 }],
    status: { isRunning: false, lastRunAt: NOW - 20 * MINUTE, lastError: null },
  },
  {
    id: 'internal:night-lock',
    name: 'Lock up for the night',
    addonId: 'core-blocks',
    source: 'internal',
    readOnly: false,
    steps: [{ kind: 'wait', seconds: 2 }],
    status: { isRunning: false, lastRunAt: null, lastError: null },
  },
  {
    id: 'provider-homeassistant:movie-night',
    name: 'Movie night',
    addonId: 'provider-homeassistant',
    source: 'addon',
    readOnly: true,
    status: {
      isRunning: false,
      lastRunAt: NOW - 3_600_000,
      lastError: 'Scene unavailable',
    },
  },
]

const TRACES = [
  {
    runId: 'run-1',
    startedAt: NOW - 20 * MINUTE,
    endedAt: NOW - 20 * MINUTE + 6_000,
    trigger: {
      kind: 'detection',
      outcome: 'pass',
      reason: 'animal seen by Kitchen in Bowl',
      vars: { deviceId: 101, className: 'animal' },
    },
    conditions: [],
    steps: [{ path: '0', kind: 'action', outcome: 'ok' }],
    outcome: 'ran',
    repeat: 1,
    lastAt: NOW - 20 * MINUTE,
  },
  {
    runId: 'run-2',
    startedAt: NOW - 50 * MINUTE,
    endedAt: NOW - 50 * MINUTE,
    trigger: {
      kind: 'detection',
      outcome: 'pass',
      reason: 'animal seen by Kitchen in Bowl',
      vars: { deviceId: 101, className: 'animal' },
    },
    conditions: [],
    verdict: {
      mode: { mode: 'cooldown', minutes: 60 },
      decision: 'cooldown',
      reason: 'ran 30 min ago',
    },
    steps: [],
    outcome: 'skipped-cooldown',
    repeat: 4,
    lastAt: NOW - 25 * MINUTE,
  },
  {
    runId: 'run-3',
    startedAt: NOW - 3 * 3_600_000,
    endedAt: NOW - 3 * 3_600_000 + 2_000,
    trigger: {
      kind: 'interval',
      outcome: 'pass',
      reason: 'every 480 minutes',
      vars: {},
    },
    conditions: [],
    steps: [
      {
        path: '0',
        kind: 'action',
        outcome: 'error',
        message: 'Feeder offline',
      },
    ],
    outcome: 'failed',
    repeat: 1,
    lastAt: NOW - 3 * 3_600_000,
  },
]

export default defineFixtures({
  area: 'build',
  description: 'Build page: Actions tab, simplified automation editor, camera Linked actions',
  handlers: {
    'deviceManager.listAll': [KITCHEN, GARAGE, FEEDER],
    'deviceManager.getDevice': (input: { deviceId?: number }) =>
      [KITCHEN, GARAGE, FEEDER].find((d) => d.id === input.deviceId) ?? null,
    'deviceManager.getBindings': (input: { deviceId?: number }) => ({
      deviceId: input.deviceId ?? 0,
      entries:
        input.deviceId === 201
          ? [
              {
                capName: 'pet-feeder',
                kind: 'native',
                providerAddonId: 'provider-homeassistant',
                providerNodeId: 'hub',
                nativeAddonId: 'provider-homeassistant',
              },
            ]
          : [],
    }),
    'deviceManager.listSiteZones': [],
    'deviceManager.getWireableFields': (input: { deviceId?: number }) =>
      input.deviceId === 201
        ? {
            caps: [
              {
                cap: 'pet-feeder',
                fields: [
                  { path: 'hopperLevel', kind: 'number' },
                  { path: 'feeding', kind: 'boolean' },
                ],
              },
            ],
          }
        : { caps: [] },
    'deviceState.getSnapshot': (input: { deviceId?: number }) =>
      input.deviceId === 201 ? { 'pet-feeder': { hopperLevel: 64, feeding: false } } : {},
    'addons.list': [
      {
        manifest: {
          id: 'provider-reolink',
          name: 'Reolink',
          packageName: 'x',
          packageVersion: '1',
        },
        source: 'npm',
      },
      {
        manifest: {
          id: 'provider-homeassistant',
          name: 'Home Assistant',
          packageName: 'y',
          packageVersion: '1',
        },
        source: 'npm',
      },
    ],
    'integrations.list': [
      {
        id: 'int-ha',
        addonId: 'provider-homeassistant',
        name: 'Casa',
        enabled: true,
        info: {},
        createdAt: 0,
        updatedAt: 0,
        processState: 'running',
      },
    ],
    'zones.listZones': (input: { deviceId?: number }) =>
      input.deviceId === 101
        ? [
            { id: 'zone-bowl', name: 'Bowl' },
            { id: 'zone-door', name: 'Back door' },
          ]
        : [],
    'coreBlocks.list': { blocks: [BLOCK] },
    'coreBlocks.listCompositions': { state: 'loaded', views: [] },
    'coreBlocks.getTraces': { traces: TRACES, lastError: null },
    'actions.list': ACTIONS,
    'actions.getTraces': { traces: TRACES.slice(0, 1) },
    'actions.getLinks': (input: { deviceId?: number }) => ({
      deviceId: input.deviceId ?? 0,
      actionIds: input.deviceId === 101 ? ['internal:feed-dog'] : [],
    }),
    'actions.listForCamera': (input: { deviceId?: number }) =>
      input.deviceId === 101 ? [ACTIONS[0]] : [],
    'mut:actions.run': { runId: 'run-new', outcome: 'started' },
    'mut:actions.setLinks': (input: unknown) => input,
  },
})
