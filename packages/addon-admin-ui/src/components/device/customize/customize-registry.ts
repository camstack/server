/**
 * The one registry of Customize kinds (D1098, phase 1): every kind of
 * `CUSTOMIZE_KINDS` wired to the implementation that exists today. Nothing here
 * changes behaviour. A piece a kind lacks is a typed `gap` naming the phase
 * that removes it; the type refuses any other omission.
 */
import { LINKED_TRIGGER_TEMPLATE_ID } from '@camstack/types'
import { planCustomizationSave } from './customization-save'
import {
  CUSTOMIZE_KINDS,
  type CustomizeGapPhase,
  type CustomizeKind,
  type CustomizeKindSpec,
  type CustomizePiece,
  type CustomizeRegistry,
  type PieceGap,
} from './customize-spec'
import { KeyedArrayCard } from './keyed/KeyedArrayCard'
import { KeyedArrayItemDialog } from './keyed/KeyedArrayItemDialog'
import { EventPulseDialog } from './event/EventPulseDialog'
import { LinkedActionItem } from './kinds/LinkedActionsCard'
import { LinkedCameraItem } from './kinds/LinkedCamerasRows'
import { LinkedDevicesTable } from './kinds/LinkedDevicesTable'
import { OverrideFieldRow } from './override-row/OverrideFieldRow'
import { FollowSwitchToggle } from './scalar/FollowSwitchToggle'
import { ScalarOverrideDialog } from './scalar/ScalarOverrideDialog'
import { SourceSelectorDevicesDialog } from './source-selector/SourceSelectorDevicesDialog'
import { CapLinkRow } from './table/CapLinkRow'
import { ConfigValueCell } from './table/ConfigRowCells'
import { EventActionsCell } from './table/EventRowCells'
import { RowActiveSwitch } from './table/RowActiveSwitch'
import { ScalarSourceCell } from './table/ScalarRowParts'
import { TriggerDialog } from './triggers/TriggerDialog'
import { TriggerRowCard } from './triggers/TriggerRowCard'
import { useConfirmRemove } from './use-confirm-remove'

/** The gap of piece `piece`, to be removed in `phase`. */
function gap<P extends CustomizePiece>(piece: P, phase: CustomizeGapPhase): PieceGap<P> {
  return { gap: { piece, phase } }
}

const COMPOSITION_STAMP = { present: { field: 'expectedUpdatedAt', plan: planCustomizationSave } }
const FIELDS_DISCRIMINANT = { present: { key: 'kind', value: 'fields' } }
const CONFIRM_REMOVE = { present: { confirm: useConfirmRemove } }
const ROW_SWITCH = { present: { control: RowActiveSwitch } }

/**
 * A scalar-row kind keeps its record in the `fields` feature of the device's
 * composition, with no marker of its own: that is the discriminant gap.
 */
const POWER_SOURCE: CustomizeKindSpec = {
  kind: 'power-source',
  storage: { shape: 'composition-feature', discriminant: gap('discriminant', 2) },
  owner: {
    row: { present: { component: ScalarSourceCell } },
    // Editing a power source opens the formula dialog, not the common SourceSelector.
    dialog: gap('dialog', 2),
    remove: CONFIRM_REMOVE,
    enabled: ROW_SWITCH,
  },
  linkedSide: gap('linkedSide', 3),
  stamp: COMPOSITION_STAMP,
}

export const CUSTOMIZE_REGISTRY: CustomizeRegistry = {
  'field-override': {
    kind: 'field-override',
    storage: { shape: 'composition-feature', discriminant: FIELDS_DISCRIMINANT },
    owner: {
      row: { present: { component: OverrideFieldRow } },
      dialog: { present: { component: ScalarOverrideDialog } },
      remove: CONFIRM_REMOVE,
      enabled: ROW_SWITCH,
    },
    linkedSide: gap('linkedSide', 3),
    stamp: COMPOSITION_STAMP,
  },
  'power-source': POWER_SOURCE,
  'lock-door-sensor': {
    kind: 'lock-door-sensor',
    storage: { shape: 'composition-feature', discriminant: gap('discriminant', 2) },
    owner: {
      row: { present: { component: ScalarSourceCell } },
      dialog: { present: { component: ScalarOverrideDialog } },
      remove: CONFIRM_REMOVE,
      enabled: ROW_SWITCH,
    },
    linkedSide: gap('linkedSide', 3),
    stamp: COMPOSITION_STAMP,
  },
  'follow-switch': {
    kind: 'follow-switch',
    // ON stores nothing and OFF stores an opt-out feature recognised by its shape.
    storage: { shape: 'composition-feature', discriminant: gap('discriminant', 2) },
    owner: {
      row: { present: { component: FollowSwitchToggle } },
      dialog: gap('dialog', 2),
      remove: gap('remove', 2),
      enabled: { present: { control: FollowSwitchToggle } },
    },
    linkedSide: gap('linkedSide', 3),
    stamp: COMPOSITION_STAMP,
  },
  'keyed-items': {
    kind: 'keyed-items',
    storage: { shape: 'composition-feature', discriminant: FIELDS_DISCRIMINANT },
    owner: {
      row: { present: { component: KeyedArrayCard } },
      dialog: { present: { component: KeyedArrayItemDialog } },
      remove: CONFIRM_REMOVE,
      enabled: gap('enabled', 2),
    },
    linkedSide: gap('linkedSide', 3),
    stamp: COMPOSITION_STAMP,
  },
  event: {
    kind: 'event',
    storage: { shape: 'composition-feature', discriminant: FIELDS_DISCRIMINANT },
    owner: {
      row: { present: { component: EventActionsCell } },
      dialog: { present: { component: EventPulseDialog } },
      remove: CONFIRM_REMOVE,
      enabled: ROW_SWITCH,
    },
    linkedSide: gap('linkedSide', 3),
    stamp: COMPOSITION_STAMP,
  },
  'config-extension': {
    kind: 'config-extension',
    storage: { shape: 'composition-feature', discriminant: FIELDS_DISCRIMINANT },
    owner: {
      row: { present: { component: ConfigValueCell } },
      dialog: gap('dialog', 2),
      remove: gap('remove', 2),
      enabled: gap('enabled', 2),
    },
    linkedSide: gap('linkedSide', 3),
    stamp: COMPOSITION_STAMP,
  },
  'cap-link': {
    kind: 'cap-link',
    storage: {
      shape: 'composition-feature',
      discriminant: { present: { key: 'kind', value: 'capLink' } },
    },
    owner: {
      row: { present: { component: CapLinkRow } },
      // A private picker, and removal is "clear the picker".
      dialog: gap('dialog', 2),
      remove: gap('remove', 2),
      enabled: gap('enabled', 2),
    },
    linkedSide: gap('linkedSide', 3),
    stamp: COMPOSITION_STAMP,
  },
  'linked-devices': {
    kind: 'linked-devices',
    storage: {
      shape: 'extension-slot',
      discriminant: { present: { key: 'slot', value: 'linked-devices' } },
    },
    owner: {
      row: { present: { component: LinkedDevicesTable } },
      dialog: { present: { component: SourceSelectorDevicesDialog } },
      remove: CONFIRM_REMOVE,
      enabled: { notTogglable: 'a slot value lists linked devices and has no enabled flag' },
    },
    // The camera side: cameras that link this device, read from their slots.
    linkedSide: { present: { view: LinkedCameraItem } },
    stamp: gap('stamp', 2),
  },
  'linked-actions': {
    kind: 'linked-actions',
    storage: { shape: 'action-links', discriminant: gap('discriminant', 2) },
    owner: {
      row: { present: { component: LinkedActionItem } },
      // A private picker, and the toggle is a Checkbox.
      dialog: gap('dialog', 2),
      remove: gap('remove', 2),
      enabled: gap('enabled', 2),
    },
    linkedSide: gap('linkedSide', 3),
    stamp: gap('stamp', 2),
  },
  'triggered-by': {
    kind: 'triggered-by',
    storage: {
      shape: 'automation',
      discriminant: { present: { key: 'templateId', value: LINKED_TRIGGER_TEMPLATE_ID } },
    },
    owner: {
      row: { present: { component: TriggerRowCard } },
      dialog: { present: { component: TriggerDialog } },
      remove: gap('remove', 2),
      enabled: { present: { control: TriggerRowCard } },
    },
    linkedSide: gap('linkedSide', 3),
    stamp: gap('stamp', 2),
  },
}

/** The spec of one kind. */
export function customizeSpecOf(kind: CustomizeKind): CustomizeKindSpec {
  return CUSTOMIZE_REGISTRY[kind]
}

/** Every registered spec in list order. */
export function customizeSpecs(): readonly CustomizeKindSpec[] {
  return CUSTOMIZE_KINDS.map(customizeSpecOf)
}
