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
import {
  LINKED_TRIGGER_SOURCES_MAX,
  LINKED_TRIGGER_TARGET_INPUT,
  LINKED_TRIGGER_TEMPLATE_ID,
} from './linked-trigger.js'

export const BUILTIN_TEMPLATE_ID_PREFIX = 'builtin:'

export interface BuiltinAutomationTemplate {
  readonly id: string
  readonly name: string
  readonly payload: AutomationTemplatePayload
}

/** The optional limit a built-in ends with: no value, no limit. */
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

/**
 * D1086: a device is commanded when other devices fire an event. Shown on the
 * commanded device's Customize tab; see `linked-trigger.ts` for the typed
 * parameters. Queued, so two quick presses are two toggles.
 */
const linkedTrigger: BuiltinAutomationTemplate = {
  id: LINKED_TRIGGER_TEMPLATE_ID,
  name: 'Linked trigger',
  payload: {
    version: AUTOMATION_TEMPLATE_VERSION,
    description: 'Commands one device (on, off or toggle) when a device fires an event.',
    body: {
      when: { kind: 'any', children: [] },
      actions: [{ kind: 'command' }],
      runMode: { mode: 'queued', max: 5 },
    },
    inputs: [
      { kind: 'device', key: LINKED_TRIGGER_TARGET_INPUT, label: 'Device to command' },
      {
        kind: 'action',
        key: 'action',
        label: 'Action',
        deviceInput: LINKED_TRIGGER_TARGET_INPUT,
      },
      {
        kind: 'entries',
        key: 'when',
        label: 'When',
        entry: 'trigger',
        allow: ['device-fired', 'device-event'],
        maxItems: LINKED_TRIGGER_SOURCES_MAX,
      },
    ],
    bindings: [
      {
        kind: 'value',
        input: LINKED_TRIGGER_TARGET_INPUT,
        path: ['actions', 0, 'target'],
        as: 'target',
      },
      { kind: 'value', input: 'action', path: ['actions', 0] },
      { kind: 'entries', input: 'when', path: ['when', 'children'] },
    ],
  },
}

export const BUILTIN_AUTOMATION_TEMPLATES: readonly BuiltinAutomationTemplate[] = [
  motionLight,
  linkedTrigger,
]

export function isBuiltinTemplateId(id: string): boolean {
  return id.startsWith(BUILTIN_TEMPLATE_ID_PREFIX)
}

export function builtinAutomationTemplate(id: string): BuiltinAutomationTemplate | undefined {
  return BUILTIN_AUTOMATION_TEMPLATES.find((t) => t.id === id)
}
