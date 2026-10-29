/**
 * The preset for a pet water fountain built from loose entities (D659, D967).
 *
 * A fountain reaches CamStack as a container of single-purpose entities: a
 * pump switch, a cycle switch, two number boxes, a handful of sensors that
 * report millilitres as text, and a few buttons. This preset names the
 * `pet-fountain` cap's fields over those entities, forwards each of its five
 * methods to ONE entity method, and adds the filter as a resettable
 * `consumables` item.
 *
 * Stored quantities are base units (D944): litres for volume, seconds for
 * duration. The cycle times cannot be read back (see `pumpOnTime` below). The sensors are `enum-sensor`s, so their value is a STRING:
 * `number(x)` reads it and anything that is not a number stays `null`, never
 * 0 (D393). The caller supplies the sources — it knows which entity is which;
 * the preset guesses no entity id.
 */
import { DeviceType } from '../../device/device-type.js'
import {
  type Composition,
  type CompositionBinding,
  type CompositionFieldSource,
  type CompositionFromSource,
  CompositionSchema,
  type CompositionSourceRef,
} from '../composition.js'

/** The optional filter of a fountain: its remaining days and the "filter changed" button. */
export interface PetFountainFilterSources {
  /** An `enum-sensor` whose value is the days left, as a numeric string. */
  readonly daysRemaining: CompositionSourceRef
  /** A `button` the filter reset presses. */
  readonly changed: CompositionSourceRef
}

/** The entities a pet fountain is built from. */
export interface PetFountainEntitySources {
  /** `enum-sensor.value`: tank level, percent as text. */
  readonly waterLevel: CompositionSourceRef
  /** `enum-sensor.value`: tank volume, millilitres as text. */
  readonly waterVolume: CompositionSourceRef
  /** `switch`: the pump. */
  readonly pump: CompositionSourceRef
  /** `switch`: the on/off duty cycle. */
  readonly pumpInterval: CompositionSourceRef
  /** `control` (numeric): minutes the pump runs per cycle. */
  readonly pumpOnMinutes: CompositionSourceRef
  /** `control` (numeric): minutes the pump rests per cycle. */
  readonly pumpOffMinutes: CompositionSourceRef
  /** `enum-sensor.value`: the last drink, millilitres as text. */
  readonly lastDrink: CompositionSourceRef
  /** `enum-sensor.value`: this hour's drinking, millilitres as text. */
  readonly currentHourDrink: CompositionSourceRef
  /** `enum-sensor.value`: the rolling 24 h drinking, millilitres as text. */
  readonly last24hDrink: CompositionSourceRef
  /** `enum-sensor.value`: today's drinking, millilitres as text. */
  readonly todayDrink: CompositionSourceRef
  /** `button`: clears the rolling daily counters. */
  readonly clearDaily: CompositionSourceRef
  /** Present when the fountain has a filter entity pair; adds a `filter` consumable. */
  readonly filter?: PetFountainFilterSources
}

const UNKNOWN: CompositionFieldSource = { kind: 'expression', expr: 'null', bindings: {} }
const NOW: CompositionFieldSource = { kind: 'expression', expr: 'now', bindings: {} }

function from(source: CompositionSourceRef, cap: string, fieldPath: string): CompositionFromSource {
  return { kind: 'from', source, cap, fieldPath }
}

function over(name: string, binding: CompositionBinding, expr: string): CompositionFieldSource {
  return { kind: 'expression', expr, bindings: { [name]: binding } }
}

/** A text reading in millilitres, as litres; unreadable stays unknown. */
function millilitresAsLitres(source: CompositionSourceRef): CompositionFieldSource {
  return over(
    'v',
    from(source, 'enum-sensor', 'value'),
    'number(v) == null ? null : number(v) / 1000',
  )
}

function percentOf(source: CompositionSourceRef): CompositionFieldSource {
  return over('l', from(source, 'enum-sensor', 'value'), 'number(l)')
}

function filterFeature(filter: PetFountainFilterSources) {
  const days = { d: from(filter.daysRemaining, 'enum-sensor', 'value') }
  return {
    kind: 'fields',
    cap: 'consumables',
    fields: { lastChangedAt: NOW, lastFetchedAt: NOW },
    items: {
      filter: {
        label: 'Filter',
        fields: {
          'remaining.value': { kind: 'expression', expr: 'number(d)', bindings: days },
          'remaining.kind': { kind: 'expression', expr: '"duration"', bindings: {} },
          status: {
            kind: 'expression',
            expr: 'number(d) == null ? null : (number(d) <= 0 ? "replace" : "ok")',
            bindings: days,
          },
        },
        reset: { kind: 'forward', source: filter.changed, cap: 'button', method: 'press' },
      },
    },
  }
}

export function petFountainFromEntitiesComposition(sources: PetFountainEntitySources): Composition {
  const minutes = { kind: 'numeric', value: { $input: 'minutes' } }
  return CompositionSchema.parse({
    target: { kind: 'new', type: DeviceType.PetFountain },
    features: [
      {
        kind: 'fields',
        cap: 'pet-fountain',
        fields: {
          waterLevel: percentOf(sources.waterLevel),
          waterVolume: millilitresAsLitres(sources.waterVolume),
          empty: over(
            'l',
            from(sources.waterLevel, 'enum-sensor', 'value'),
            'number(l) == null ? null : number(l) <= 0',
          ),
          pumpRunning: from(sources.pump, 'switch', 'on'),
          pumpIntervalEnabled: from(sources.pumpInterval, 'switch', 'on'),
          // A number box's value is a number-or-text union, which a composition cannot
          // read (`control.value` is not a wireable field), so the current cycle times
          // stay unknown; the setters still work through their forwards.
          pumpOnTime: UNKNOWN,
          pumpOffTime: UNKNOWN,
          lastDrink: millilitresAsLitres(sources.lastDrink),
          currentHourDrink: millilitresAsLitres(sources.currentHourDrink),
          last24hDrink: millilitresAsLitres(sources.last24hDrink),
          todayDrink: millilitresAsLitres(sources.todayDrink),
          error: UNKNOWN,
          lastFetchedAt: NOW,
        },
        commands: {
          setPump: { kind: 'forward', source: sources.pump, cap: 'switch', method: 'setState' },
          setPumpInterval: {
            kind: 'forward',
            source: sources.pumpInterval,
            cap: 'switch',
            method: 'setState',
          },
          setPumpOnMinutes: {
            kind: 'forward',
            source: sources.pumpOnMinutes,
            cap: 'control',
            method: 'setValue',
            args: { control: minutes },
          },
          setPumpOffMinutes: {
            kind: 'forward',
            source: sources.pumpOffMinutes,
            cap: 'control',
            method: 'setValue',
            args: { control: minutes },
          },
          resetDailyConsumption: {
            kind: 'forward',
            source: sources.clearDaily,
            cap: 'button',
            method: 'press',
          },
        },
      },
      ...(sources.filter === undefined ? [] : [filterFeature(sources.filter)]),
    ],
  })
}
