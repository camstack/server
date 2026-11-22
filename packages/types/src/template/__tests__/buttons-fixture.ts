/**
 * The payload the retired "Buttons → devices" built-in carried, kept as a
 * fixture: it exercises the generic group / entries / row-ids inputs and the
 * time-window gate of the template engine, which operator templates still use.
 */
import {
  AUTOMATION_TEMPLATE_VERSION,
  type AutomationTemplatePayload,
  type TemplateGateBinding,
  type TemplateScalarInput,
} from '../automation-template.js'

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

export const BUTTONS_FIXTURE_ID = 'fixture:buttons'

export const BUTTONS_FIXTURE_PAYLOAD: AutomationTemplatePayload = {
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
}
