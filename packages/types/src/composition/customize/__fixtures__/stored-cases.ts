/**
 * Stored values the generic scalar compiler writes. `compile(input)` equals
 * `stored`, and `decode` then `compile` comes back to the same value.
 */
import type { CompositionFieldSource, CompositionFieldsFeature } from '../../composition.js'
import type { CompositionSourceRef } from '../../composition.js'
import {
  RUNNING_POWER_START_DELAY_MS,
  RUNNING_POWER_STOP_DELAY_MS,
  RUNNING_POWER_THRESHOLD_WATTS,
} from '../../../running-state/defaults.js'
import type { ScalarCompileInput } from '../scalar-compile.js'
import type { ScalarOverrideDraft } from '../override-draft.js'
import { expression, fromRead, literal } from '../field-source.js'
import type { CustomizeStored } from '../stored.js'
import { BATTERY_NUMBER, DESICCANT_STRING, DISHWASHER, FEEDER, SWITCH_REF } from './refs.js'

export interface CustomizeStoredCase {
  readonly id: string
  readonly input: ScalarCompileInput
  readonly stored: CustomizeStored
}

function composition(
  target: CompositionSourceRef,
  feature: CompositionFieldsFeature,
): CustomizeStored {
  return { family: 'composition', target, feature }
}

function scalarInput(
  device: CompositionSourceRef,
  draft: ScalarOverrideDraft,
  apply: 'add' | 'replace',
  sourceValueKind: ScalarCompileInput['sourceValueKind'],
  changedAtField: string | null,
  sourceUnit: string | null,
): ScalarCompileInput {
  return { draft, device, apply, sourceValueKind, changedAtField, sourceUnit }
}

function read(
  source: CompositionSourceRef,
  cap: string,
  fieldPath: string,
): ScalarOverrideDraft['source'] {
  return { addonId: source.addonId, stableId: source.stableId, cap, fieldPath }
}

const batteryAddFields = {
  level: fromRead(BATTERY_NUMBER.source, BATTERY_NUMBER.cap, BATTERY_NUMBER.fieldPath),
  charging: literal('"unknown"'),
  sleeping: literal('false'),
  lastUpdated: literal('now'),
}

const batteryStringPercentage = expression('number(x)', {
  x: fromRead(DESICCANT_STRING.source, DESICCANT_STRING.cap, DESICCANT_STRING.fieldPath),
})

const consumableClocks = {
  lastChangedAt: literal('now'),
  lastFetchedAt: literal('now'),
}

const foodItem = {
  label: 'Food',
  fields: {
    level: fromRead(BATTERY_NUMBER.source, BATTERY_NUMBER.cap, BATTERY_NUMBER.fieldPath),
  },
}

const runningClocks = {
  source: literal('"assigned"'),
  phase: literal('null'),
  lastFetchedAt: literal('now'),
}

const switchRead = fromRead(SWITCH_REF, 'switch', 'on')
const powerRead = fromRead(SWITCH_REF, 'power-meter', 'power')

function runningFeature(
  running: CompositionFieldSource,
  since: CompositionFieldSource,
): CompositionFieldsFeature {
  return {
    kind: 'fields',
    cap: 'running-state',
    fields: { ...runningClocks, running, since },
  }
}

const cases: readonly CustomizeStoredCase[] = [
  {
    id: 'battery-add-number',
    input: scalarInput(
      FEEDER,
      {
        kind: 'scalar',
        cap: 'battery',
        targetId: 'level',
        source: read(BATTERY_NUMBER.source, BATTERY_NUMBER.cap, BATTERY_NUMBER.fieldPath),
        transform: { kind: 'identity' },
      },
      'add',
      'number',
      null,
      null,
    ),
    stored: composition(FEEDER, { kind: 'fields', cap: 'battery', fields: batteryAddFields }),
  },
  {
    id: 'battery-replace-number',
    input: scalarInput(
      FEEDER,
      {
        kind: 'scalar',
        cap: 'battery',
        targetId: 'level',
        source: read(BATTERY_NUMBER.source, BATTERY_NUMBER.cap, BATTERY_NUMBER.fieldPath),
        transform: { kind: 'identity' },
      },
      'replace',
      'number',
      null,
      null,
    ),
    stored: composition(FEEDER, {
      kind: 'fields',
      cap: 'battery',
      fields: { level: batteryAddFields.level },
    }),
  },
  {
    id: 'battery-add-numeric-string',
    input: scalarInput(
      FEEDER,
      {
        kind: 'scalar',
        cap: 'battery',
        targetId: 'level',
        source: read(DESICCANT_STRING.source, DESICCANT_STRING.cap, DESICCANT_STRING.fieldPath),
        transform: { kind: 'identity' },
      },
      'add',
      'string',
      null,
      null,
    ),
    stored: composition(FEEDER, {
      kind: 'fields',
      cap: 'battery',
      fields: { ...batteryAddFields, level: batteryStringPercentage },
    }),
  },
  {
    id: 'running-switch',
    input: scalarInput(
      DISHWASHER,
      {
        kind: 'scalar',
        cap: 'running-state',
        targetId: 'running',
        source: read(SWITCH_REF, 'switch', 'on'),
        transform: { kind: 'identity' },
      },
      'replace',
      'boolean',
      'lastChangedAt',
      null,
    ),
    stored: composition(
      DISHWASHER,
      runningFeature(switchRead, fromRead(SWITCH_REF, 'switch', 'lastChangedAt')),
    ),
  },
  {
    id: 'running-invert',
    input: scalarInput(
      DISHWASHER,
      {
        kind: 'scalar',
        cap: 'running-state',
        targetId: 'running',
        source: read(SWITCH_REF, 'binary', 'on'),
        transform: { kind: 'invert' },
      },
      'replace',
      'boolean',
      null,
      null,
    ),
    stored: composition(
      DISHWASHER,
      runningFeature(
        expression('!x', { x: fromRead(SWITCH_REF, 'binary', 'on') }),
        expression('latchedAt(running)', {
          running: fromRead(DISHWASHER, 'running-state', 'running'),
        }),
      ),
    ),
  },
  {
    id: 'running-power',
    input: scalarInput(
      DISHWASHER,
      {
        kind: 'scalar',
        cap: 'running-state',
        targetId: 'running',
        source: read(SWITCH_REF, 'power-meter', 'power'),
        transform: {
          kind: 'threshold',
          comparison: 'gte',
          threshold: RUNNING_POWER_THRESHOLD_WATTS,
          startDwellMs: RUNNING_POWER_START_DELAY_MS,
          stopDwellMs: RUNNING_POWER_STOP_DELAY_MS,
        },
      },
      'replace',
      'number',
      null,
      'W',
    ),
    stored: composition(
      DISHWASHER,
      runningFeature(
        expression(
          `dwell(x >= ${RUNNING_POWER_THRESHOLD_WATTS}, ${RUNNING_POWER_START_DELAY_MS}, ${RUNNING_POWER_STOP_DELAY_MS})`,
          { x: powerRead },
        ),
        expression('latchedAt(running)', {
          running: fromRead(DISHWASHER, 'running-state', 'running'),
        }),
      ),
    ),
  },
]

export const CUSTOMIZE_STORED_CASES: readonly CustomizeStoredCase[] = cases

export interface NoncanonicalCustomizeStored {
  readonly id: string
  readonly stored: CustomizeStored
}

const handWrittenBattery: CompositionFieldsFeature = {
  kind: 'fields',
  cap: 'battery',
  fields: { ...batteryAddFields, sleeping: literal('true') },
}

export const NONCANONICAL_CUSTOMIZE_STORED: readonly NoncanonicalCustomizeStored[] = [
  { id: 'battery-hand-written-companion', stored: composition(FEEDER, handWrittenBattery) },
  {
    id: 'consumable-extra-leaf',
    stored: composition(FEEDER, {
      kind: 'fields',
      cap: 'consumables',
      fields: consumableClocks,
      items: {
        food: {
          ...foodItem,
          fields: { ...foodItem.fields, status: literal('"ok"') },
        },
      },
    }),
  },
]
