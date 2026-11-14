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
  type TemplateGateBinding,
  type TemplateScalarInput,
} from './automation-template.js'

export const BUILTIN_TEMPLATE_ID_PREFIX = 'builtin:'

export interface BuiltinAutomationTemplate {
  readonly id: string
  readonly name: string
  readonly payload: AutomationTemplatePayload
}

/** One choose branch per row, so the rows a group takes are the branches a choose takes. */
const BUTTON_ROWS_MAX = 6
const ROW_ENTRIES_MAX = 10

/** The optional limit both built-ins end with: no value, no limit. */
const ACTIVE_WINDOW_KEY = 'active'
const activeWindowInput: TemplateScalarInput = {
  kind: 'time-window',
  key: ACTIVE_WINDOW_KEY,
  label: 'Only when',
  description: 'Limit the automation to a time of day, to some days, or both.',
  optional: true,
}
/** Declared last: it moves the tree the other bindings write into one level down. */
const activeWindowGate: TemplateGateBinding = {
  kind: 'gate',
  input: ACTIVE_WINDOW_KEY,
  path: ['when'],
}

const buttonsToDevices: BuiltinAutomationTemplate = {
  id: `${BUILTIN_TEMPLATE_ID_PREFIX}buttons-to-devices`,
  name: 'Buttons → devices',
  payload: {
    version: AUTOMATION_TEMPLATE_VERSION,
    description: 'Each button: when it sends an event, run one or more actions.',
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
        rowLabel: 'button',
        maxRows: BUTTON_ROWS_MAX,
        inputs: [
          {
            kind: 'entries',
            key: 'when',
            label: 'When',
            entry: 'trigger',
            allow: ['device-fired'],
            maxItems: ROW_ENTRIES_MAX,
          },
          {
            kind: 'entries',
            key: 'do',
            label: 'Actions',
            entry: 'step',
            allow: ['command'],
            maxItems: ROW_ENTRIES_MAX,
          },
        ],
      },
      activeWindowInput,
    ],
    bindings: [
      // Every button's triggers, verbatim, are the automation's `any`.
      { kind: 'entries', input: 'when', in: 'buttons', path: ['when', 'children'] },
      {
        kind: 'rows',
        input: 'buttons',
        path: ['actions', 0, 'branches'],
        item: {
          if: { kind: 'triggered-by', leafIds: [] },
          steps: [],
        },
        bindings: [
          { kind: 'row-ids', input: 'when', path: ['if', 'leafIds'] },
          { kind: 'entries', input: 'do', path: ['steps'] },
        ],
      },
      activeWindowGate,
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
      when: {
        kind: 'device-becomes',
        cap: 'motion',
        fieldPath: 'detected',
        becomes: true,
      },
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
      activeWindowInput,
    ],
    bindings: [
      { kind: 'value', input: 'sensor', path: ['when', 'deviceId'] },
      {
        kind: 'value',
        input: 'lights',
        path: ['actions', 0, 'target'],
        as: 'target',
      },
      { kind: 'value', input: 'delay', path: ['actions', 1, 'seconds'] },
      {
        kind: 'value',
        input: 'lights',
        path: ['actions', 2, 'target'],
        as: 'target',
      },
      activeWindowGate,
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
