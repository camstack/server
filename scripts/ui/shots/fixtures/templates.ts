/**
 * Build → Templates tab (`/build?tab=templates`) and the automations made from
 * a template: one remote template, one user automation template, the shipped
 * built-ins, and the automations list with an instance and a flagged instance.
 * Reuses the `build` area's devices and the `remote` area's remote template.
 */
import { generateAutomationBlock } from '../../../../packages/types/src/automation/codegen.ts'
import { BUILTIN_AUTOMATION_TEMPLATES } from '../../../../packages/types/src/template/builtin-automation-templates.ts'
import { defineFixtures } from './_define'
import { NOW } from './_time'
import build from './build'
import remote from './remote'

/** The shipped buttons template, so the use-template form can be shot. */
const BUTTONS_TO_DEVICES = BUILTIN_AUTOMATION_TEMPLATES.find(
  (template) => template.id === 'builtin:buttons-to-devices',
)
if (BUTTONS_TO_DEVICES === undefined) {
  throw new Error('builtin:buttons-to-devices is not in BUILTIN_AUTOMATION_TEMPLATES')
}

const MOTION_BODY = {
  when: {
    kind: 'device-becomes',
    deviceId: 101,
    cap: 'motion',
    fieldPath: 'detected',
    becomes: true,
  },
  actions: [
    { kind: 'command', actionId: 'switch.on', target: { kind: 'devices', ids: [201] } },
    { kind: 'wait', seconds: 300 },
  ],
}

const MOTION_PAYLOAD = {
  version: 1,
  description: 'A sensor turns lights on, waits, turns them off.',
  body: MOTION_BODY,
  inputs: [
    { kind: 'device', key: 'sensor', label: 'Sensor', filter: { capability: 'motion' } },
    { kind: 'device', key: 'lights', label: 'Lights', multiple: true },
    { kind: 'duration', key: 'delay', label: 'Delay', min: 10, max: 3600, default: 300 },
  ],
  bindings: [
    { kind: 'value', input: 'sensor', path: ['when', 'deviceId'] },
    { kind: 'value', input: 'lights', path: ['actions', 0, 'target'], as: 'target' },
    { kind: 'value', input: 'delay', path: ['actions', 1, 'seconds'] },
  ],
}

const AUTOMATION_TEMPLATES = [
  {
    id: BUTTONS_TO_DEVICES.id,
    kind: 'automation',
    name: BUTTONS_TO_DEVICES.name,
    builtIn: true,
    payload: BUTTONS_TO_DEVICES.payload,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'builtin:motion-light',
    kind: 'automation',
    name: 'Motion → light',
    builtIn: true,
    payload: MOTION_PAYLOAD,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'builtin:buttons-devices',
    kind: 'automation',
    name: 'Buttons → devices',
    builtIn: true,
    payload: {
      version: 1,
      description: 'Each button drives its own set of devices.',
      body: { when: { kind: 'any', children: [] }, actions: [{ kind: 'choose', branches: [] }] },
      inputs: [
        {
          kind: 'group',
          key: 'buttons',
          label: 'Buttons',
          maxRows: 6,
          inputs: [
            { kind: 'device', key: 'button', label: 'Button' },
            { kind: 'device', key: 'targets', label: 'Devices', multiple: true },
          ],
        },
      ],
      bindings: [],
    },
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'tpl-garage-light',
    kind: 'automation',
    name: 'Garage light on motion',
    payload: MOTION_PAYLOAD,
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 3_600_000,
  },
]

const REMOTE_TEMPLATES = remote.handlers['template.list'] as readonly unknown[]
const ALL_TEMPLATES = [...REMOTE_TEMPLATES, ...AUTOMATION_TEMPLATES]

const instance = (id: string, name: string, templateId: string, flagged: boolean) => ({
  id,
  name,
  code: generateAutomationBlock({
    name,
    recipe: {
      ...MOTION_BODY,
      template: {
        templateId,
        values: { sensor: 101, lights: [201], delay: 300 },
        ...(flagged
          ? {
              problems: [
                { code: 'missing-input', input: 'delay', detail: 'The input delay is required.' },
              ],
            }
          : {}),
      },
    },
  }),
  enabled: true,
  placement: 'hub',
  createdAt: NOW - 86_400_000,
  updatedAt: NOW - 3_600_000,
  createdBy: 'admin',
  status: 'running',
  lastChangedAt: NOW - 3_600_000,
})

const FLEET = (
  build.handlers['deviceManager.listAll'] as readonly { id: number; name: string; type: string }[]
).map((d) => ({
  id: d.id,
  name: d.name,
  type: d.type,
  location: 'Ground floor',
  integrationId: 'int-ha',
  integrationLabel: 'Home Assistant',
  online: true,
  disabled: false,
  compatible: true,
  values: [],
}))

const searchAnswer = (items: readonly unknown[], missingIds: readonly number[]) => ({
  items,
  nextCursor: null,
  total: items.length,
  compatibleTotal: items.length,
  fleetTotal: FLEET.length,
  hiddenIncompatible: 0,
  facets: { locations: [], integrations: [], types: [] },
  suggested: [],
  missingIds,
})

const FIRST = (build.handlers['coreBlocks.list'] as { blocks: readonly unknown[] }).blocks[0]

export default defineFixtures({
  area: 'templates',
  description: 'Build → Templates, the automation template editor and automations from a template',
  handlers: {
    ...remote.handlers,
    ...build.handlers,
    'auth.listLoginMethods': [],
    'preferences.get': { rows: [] },
    'schedulers.list': [],
    'coreBlocks.list': {
      blocks: [
        FIRST,
        instance('blk-hall', 'Hall light on motion', 'builtin:motion-light', false),
        instance('blk-stairs', 'Stairs light on motion', 'builtin:motion-light', true),
      ],
    },
    'deviceManager.search': (input: { ids?: number[]; text?: string }) => {
      const ids = input.ids
      if (ids !== undefined) {
        return searchAnswer(
          FLEET.filter((d) => ids.includes(d.id)),
          ids.filter((id) => !FLEET.some((d) => d.id === id)),
        )
      }
      const text = (input.text ?? '').toLowerCase()
      return searchAnswer(
        FLEET.filter((d) => d.name.toLowerCase().includes(text)),
        [],
      )
    },
    'coreBlocks.getTraces': { traces: [], lastError: null },
    'notificationRules.getConditionCatalog': { catalog: [] },
    'template.list': ALL_TEMPLATES,
    'template.get': (i: { id: string }) =>
      (ALL_TEMPLATES as readonly { id: string }[]).find((t) => t.id === i.id) ?? null,
  },
})
