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
import { ON_FOR_MAX_SECONDS } from '../automation/on-for.js'
import {
  LINKED_TRIGGER_ON_FOR_INPUT,
  LINKED_TRIGGER_SOURCES_MAX,
  LINKED_TRIGGER_TARGET_INPUT,
  LINKED_TRIGGER_TEMPLATE_ID,
  LINKED_TRIGGER_STATE_INPUT,
  LINKED_TRIGGER_WINDOW_INPUT,
} from './linked-trigger.js'

export const BUILTIN_TEMPLATE_ID_PREFIX = 'builtin:'

export interface BuiltinAutomationTemplate {
  readonly id: string
  readonly name: string
  readonly payload: AutomationTemplatePayload
}

/** The optional limit a built-in ends with: no value, no limit. */
const ACTIVE_WINDOW_KEY = LINKED_TRIGGER_WINDOW_INPUT
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

const activeWhenInput: TemplateScalarInput = {
  kind: 'device-state',
  key: LINKED_TRIGGER_STATE_INPUT,
  label: 'Only while',
  description: 'Limit the automation to while a device reads a value, such as a derived night.',
  optional: true,
}
/** Declared after the window gate, so the device state sits inside it. */
const activeWhenGate: TemplateGateBinding = {
  kind: 'gate',
  input: LINKED_TRIGGER_STATE_INPUT,
  path: ['when'],
}

/**
 * D1086: a device is commanded when other devices fire an event. Shown on the
 * commanded device's Customize tab; see `linked-trigger.ts` for the typed
 * parameters. Queued, so two quick presses are two toggles. With a duration the
 * one step is "on for a time": the engine holds the off, outside the run.
 *
 * It replaces the retired `builtin:motion-light` ("motion → light, off after a
 * delay"): a motion source with "on for". An automation made from the retired
 * built-in keeps running its stored body and is listed with its template missing.
 */
const linkedTrigger: BuiltinAutomationTemplate = {
  id: LINKED_TRIGGER_TEMPLATE_ID,
  name: 'Linked trigger',
  payload: {
    version: AUTOMATION_TEMPLATE_VERSION,
    description:
      'Commands one device (on, off, toggle, or on for a time) when a device fires an event, reports a state or a camera detects a class.',
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
        allow: ['device-fired', 'device-event', 'device-becomes', 'detection'],
        maxItems: LINKED_TRIGGER_SOURCES_MAX,
      },
      {
        kind: 'duration',
        key: LINKED_TRIGGER_ON_FOR_INPUT,
        label: 'On for (seconds)',
        description:
          'Turns it on only if it is off, and off again after this long. A new event restarts the time.',
        min: 1,
        max: ON_FOR_MAX_SECONDS,
        optional: true,
      },
      activeWindowInput,
      activeWhenInput,
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
      {
        kind: 'value',
        input: LINKED_TRIGGER_ON_FOR_INPUT,
        path: ['actions', 0, 'onFor', 'seconds'],
      },
      activeWindowGate,
      activeWhenGate,
    ],
  },
}

export const BUILTIN_AUTOMATION_TEMPLATES: readonly BuiltinAutomationTemplate[] = [linkedTrigger]

export function isBuiltinTemplateId(id: string): boolean {
  return id.startsWith(BUILTIN_TEMPLATE_ID_PREFIX)
}

export function builtinAutomationTemplate(id: string): BuiltinAutomationTemplate | undefined {
  return BUILTIN_AUTOMATION_TEMPLATES.find((t) => t.id === id)
}
