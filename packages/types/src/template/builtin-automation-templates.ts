/**
 * Automation templates shipped with CamStack (#527). They are read-only records
 * of the template store: `template.list` returns them beside the operator's
 * own, under `builtin:` ids, and an update or delete of one is refused. They
 * are code, not seeded rows, so a new release changes them without a
 * migration and nothing an operator saved is ever overwritten.
 */
import {
  AUTOMATION_TEMPLATE_VERSION,
  type AutomationTemplatePayload,
} from './automation-template.js'

export const BUILTIN_TEMPLATE_ID_PREFIX = 'builtin:'

export interface BuiltinAutomationTemplate {
  readonly id: string
  readonly name: string
  readonly payload: AutomationTemplatePayload
}

/** One choose branch per row, so the rows a group takes are the branches a choose takes. */
const BUTTON_ROWS_MAX = 6

const buttonsToDevices: BuiltinAutomationTemplate = {
  id: `${BUILTIN_TEMPLATE_ID_PREFIX}buttons-to-devices`,
  name: 'Buttons → devices',
  payload: {
    version: AUTOMATION_TEMPLATE_VERSION,
    description: 'Each row: when a button sends an event, run an action on a set of devices.',
    body: {
      when: { kind: 'any', children: [] },
      actions: [{ kind: 'choose', branches: [] }],
      runMode: { mode: 'queued', max: 5 },
    },
    inputs: [
      {
        kind: 'group',
        key: 'buttons',
        label: 'Buttons',
        maxRows: BUTTON_ROWS_MAX,
        inputs: [
          {
            kind: 'device',
            key: 'button',
            label: 'Button',
            filter: { capability: 'event-emitter' },
          },
          { kind: 'event', key: 'event', label: 'Event', deviceInput: 'button' },
          { kind: 'device', key: 'targets', label: 'Devices', multiple: true },
          { kind: 'action', key: 'action', label: 'Action', deviceInput: 'targets' },
        ],
      },
    ],
    bindings: [
      {
        kind: 'rows',
        input: 'buttons',
        path: ['when', 'children'],
        item: { kind: 'device-fired' },
        bindings: [
          { kind: 'row-id', path: ['id'] },
          { kind: 'value', input: 'button', path: ['deviceId'] },
          { kind: 'value', input: 'event', path: [] },
        ],
      },
      {
        kind: 'rows',
        input: 'buttons',
        path: ['actions', 0, 'branches'],
        item: {
          if: { kind: 'triggered-by', leafIds: [] },
          steps: [{ kind: 'command' }],
        },
        bindings: [
          { kind: 'row-id', path: ['if', 'leafIds', 0] },
          { kind: 'value', input: 'targets', path: ['steps', 0, 'target'], as: 'target' },
          { kind: 'value', input: 'action', path: ['steps', 0] },
        ],
      },
    ],
  },
}

const motionLight: BuiltinAutomationTemplate = {
  id: `${BUILTIN_TEMPLATE_ID_PREFIX}motion-light`,
  name: 'Motion → light, off after a delay',
  payload: {
    version: AUTOMATION_TEMPLATE_VERSION,
    description:
      'Turns lights on when a motion sensor detects motion and off once it has been quiet for the delay. New motion restarts the delay.',
    body: {
      when: { kind: 'device-becomes', cap: 'motion', fieldPath: 'detected', becomes: true },
      actions: [
        { kind: 'command', actionId: 'switch.on' },
        { kind: 'wait', seconds: 300 },
        { kind: 'command', actionId: 'switch.off' },
      ],
      runMode: { mode: 'restart' },
    },
    inputs: [
      {
        kind: 'device',
        key: 'sensor',
        label: 'Motion sensor',
        filter: { capability: 'motion' },
      },
      {
        kind: 'device',
        key: 'lights',
        label: 'Lights',
        multiple: true,
        filter: { capability: 'switch' },
      },
      {
        kind: 'duration',
        key: 'delay',
        label: 'Off after (seconds)',
        min: 10,
        max: 3600,
        default: 300,
      },
    ],
    bindings: [
      { kind: 'value', input: 'sensor', path: ['when', 'deviceId'] },
      { kind: 'value', input: 'lights', path: ['actions', 0, 'target'], as: 'target' },
      { kind: 'value', input: 'delay', path: ['actions', 1, 'seconds'] },
      { kind: 'value', input: 'lights', path: ['actions', 2, 'target'], as: 'target' },
    ],
  },
}

export const BUILTIN_AUTOMATION_TEMPLATES: readonly BuiltinAutomationTemplate[] = [
  buttonsToDevices,
  motionLight,
]

export function isBuiltinTemplateId(id: string): boolean {
  return id.startsWith(BUILTIN_TEMPLATE_ID_PREFIX)
}

export function builtinAutomationTemplate(id: string): BuiltinAutomationTemplate | undefined {
  return BUILTIN_AUTOMATION_TEMPLATES.find((t) => t.id === id)
}
