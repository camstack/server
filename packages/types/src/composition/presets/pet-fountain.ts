/**
 * The preset for a pet water fountain built from loose entities (D659, D967).
 *
 * A fountain reaches CamStack as a container of single-purpose entities: a
 * pump switch, a handful of sensors that report millilitres as text, a button,
 * and — on some models — a pump duty cycle (a switch and two number boxes) and
 * maintenance pairs (days left + a "done" button). This preset names the
 * `pet-fountain` cap's fields over the entities every fountain has, forwards its
 * method to ONE entity method, and adds what a model has on top: the
 * `pump-cycle` cap when the cycle entities are given (planning#366), and one
 * resettable `consumables` item per maintenance pair (filter, cleaning, water
 * change). Nothing optional is required: a fountain without a cycle is built
 * without the cap, never refused.
 *
 * Stored quantities are base units (D944): litres for volume, seconds for
 * duration. The cycle times cannot be read back (see `onTime` below). The sensors are `enum-sensor`s, so their value is a STRING:
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

/** An optional maintenance cadence: the days left and the button that says it was done. */
export interface PetFountainCadenceSources {
  /** An `enum-sensor` whose value is the days left, as a numeric string. */
  readonly daysRemaining: CompositionSourceRef
  /** A `button` the item's reset presses. */
  readonly changed: CompositionSourceRef
}

/** The entities of the optional pump duty cycle; all three or none. */
export interface PetFountainPumpCycleSources {
  /** `switch`: the on/off duty cycle. */
  readonly interval: CompositionSourceRef
  /** `control` (numeric): minutes the pump runs per cycle. */
  readonly onMinutes: CompositionSourceRef
  /** `control` (numeric): minutes the pump rests per cycle. */
  readonly offMinutes: CompositionSourceRef
}

/** The entities a pet fountain is built from. */
export interface PetFountainEntitySources {
  /** `enum-sensor.value`: tank level, percent as text. */
  readonly waterLevel: CompositionSourceRef
  /** `enum-sensor.value`: tank volume, millilitres as text. */
  readonly waterVolume: CompositionSourceRef
  /** `switch`: the pump. */
  readonly pump: CompositionSourceRef
  /** Present when the pump has a duty cycle; adds the `pump-cycle` cap. */
  readonly pumpCycle?: PetFountainPumpCycleSources
  /** Present when the fountain has a filter entity pair; adds a `filter` consumable. */
  readonly filter?: PetFountainCadenceSources
  /** Present when the fountain tracks a cleaning cadence; adds a `cleaning` consumable. */
  readonly cleaning?: PetFountainCadenceSources
  /** Present when the fountain tracks a water-change cadence; adds a `water-change` consumable. */
  readonly waterChange?: PetFountainCadenceSources
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

function cadenceItem(label: string, cadence: PetFountainCadenceSources) {
  const days = { d: from(cadence.daysRemaining, 'enum-sensor', 'value') }
  return {
    label,
    fields: {
      'remaining.value': { kind: 'expression', expr: 'number(d)', bindings: days },
      'remaining.kind': { kind: 'expression', expr: '"duration"', bindings: {} },
      status: {
        kind: 'expression',
        expr: 'number(d) == null ? null : (number(d) <= 0 ? "replace" : "ok")',
        bindings: days,
      },
    },
    reset: { kind: 'forward', source: cadence.changed, cap: 'button', method: 'press' },
  }
}

function consumablesFeature(sources: PetFountainEntitySources) {
  const items = {
    ...(sources.filter === undefined ? {} : { filter: cadenceItem('Filter', sources.filter) }),
    ...(sources.cleaning === undefined
      ? {}
      : { cleaning: cadenceItem('Cleaning', sources.cleaning) }),
    ...(sources.waterChange === undefined
      ? {}
      : { 'water-change': cadenceItem('Water change', sources.waterChange) }),
  }
  if (Object.keys(items).length === 0) return []
  return [
    {
      kind: 'fields',
      cap: 'consumables',
      fields: { lastChangedAt: NOW, lastFetchedAt: NOW },
      items,
    },
  ]
}

function pumpCycleFeature(cycle: PetFountainPumpCycleSources) {
  const minutes = { kind: 'numeric', value: { $input: 'minutes' } }
  return {
    kind: 'fields',
    cap: 'pump-cycle',
    fields: {
      enabled: from(cycle.interval, 'switch', 'on'),
      // A number box's value is a number-or-text union, which a composition cannot
      // read (`control.value` is not a wireable field), so the current cycle times
      // stay unknown; the setters still work through their forwards.
      onTime: UNKNOWN,
      offTime: UNKNOWN,
      lastFetchedAt: NOW,
    },
    commands: {
      setEnabled: { kind: 'forward', source: cycle.interval, cap: 'switch', method: 'setState' },
      setOnMinutes: {
        kind: 'forward',
        source: cycle.onMinutes,
        cap: 'control',
        method: 'setValue',
        args: { control: minutes },
      },
      setOffMinutes: {
        kind: 'forward',
        source: cycle.offMinutes,
        cap: 'control',
        method: 'setValue',
        args: { control: minutes },
      },
    },
  }
}

export function petFountainFromEntitiesComposition(sources: PetFountainEntitySources): Composition {
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
          error: UNKNOWN,
          lastFetchedAt: NOW,
        },
        commands: {
          setPump: { kind: 'forward', source: sources.pump, cap: 'switch', method: 'setState' },
        },
      },
      ...(sources.pumpCycle === undefined ? [] : [pumpCycleFeature(sources.pumpCycle)]),
      ...consumablesFeature(sources),
    ],
  })
}
