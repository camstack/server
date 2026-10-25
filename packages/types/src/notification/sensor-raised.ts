/**
 * WHICH WAY A BOOLEAN SENSOR MOVED — read off the one slice a sensor event
 * persists (D640 "a sensor rule fires on the raise, the clear, or both").
 *
 * A device-event rule over a flood sensor notified on BOTH edges: water
 * detected, and back to dry. `NcConditions.sensorTransition` lets the rule
 * name one edge; this file answers, for one `SensorEvent`, which edge it is.
 *
 * NOT A SECOND TABLE. The "which boolean of this cap counts as HIGH" question
 * already has one answer, `SOURCE_CAP_ACTIVE_FIELD`
 * (`catalogs/sensor-active-state.ts`, the doorbell's and the recorder's edge
 * table), and a sensor event names its kind, not its cap. So the table here is
 * DERIVED: event kind → cap (`EVENT_KIND_BY_CAP`) → that cap's active field.
 * Only kinds whose taxonomy category is `sensor` take part — a switch has an
 * `on` boolean too, but "it triggers / it clears" is not a sentence about a
 * light, and offering it there would be a knob with a misleading label.
 * `presence` is a WORD (`home` / `not_home` / a zone), not a boolean, and is
 * absent from the source table, so it is absent here.
 *
 * `undefined` = never guessed: a kind with no raise (a doorbell press, a
 * button, a cover), or a slice whose field is missing or not a boolean. The
 * engine then does NOT filter — a flood alert must not go silent because one
 * read came back unreadable (the same stance as the alarm's `sensorEdgeOf`).
 *
 * Pure, RN-safe: the viewer imports the support rule from here.
 */

import { EVENT_KIND_BY_CAP } from '../capabilities/sensor-event-kinds.js'
import { SOURCE_CAP_ACTIVE_FIELD } from '../catalogs/sensor-active-state.js'

/** Event kind → the boolean field of its cap slice that means "raised". */
export const NC_SENSOR_RAISED_FIELD_BY_KIND: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(EVENT_KIND_BY_CAP).flatMap(([capName, descriptor]) => {
      const field = SOURCE_CAP_ACTIVE_FIELD[capName]
      if (field === undefined || descriptor.category !== 'sensor') return []
      return [[descriptor.kind, field]]
    }),
  ),
)

/** The sensor kinds `sensorTransition` means something for. */
export const NC_SENSOR_TRANSITION_KINDS: readonly string[] = Object.freeze(
  Object.keys(NC_SENSOR_RAISED_FIELD_BY_KIND),
)

function normaliseKind(kind: string): string {
  return kind.trim().toLowerCase()
}

/**
 * true = the sensor is raised (water, smoke, open, tampered…), false = it
 * cleared, undefined = this kind has no raise or the slice cannot say.
 */
export function sensorRaisedOf(
  kind: string,
  value: Readonly<Record<string, unknown>> | null,
): boolean | undefined {
  if (value === null) return undefined
  const field = NC_SENSOR_RAISED_FIELD_BY_KIND[normaliseKind(kind)]
  if (field === undefined) return undefined
  const raw = Object.entries(value).find(([key]) => key === field)?.[1]
  return typeof raw === 'boolean' ? raw : undefined
}

/**
 * THE SUPPORT RULE, shared by both editors: "Notify when" is offered only when
 * the rule names at least one sensor kind and EVERY kind it names has a raise.
 * A mixed rule (flood + doorbell) would hear "only when it clears" as "never
 * for the doorbell" in the operator's head while the engine lets the doorbell
 * through — so the choice is not offered, and an editor prunes it on save.
 */
export function sensorTransitionOffered(sensorKinds: readonly string[] | undefined): boolean {
  if (sensorKinds === undefined || sensorKinds.length === 0) return false
  return sensorKinds.every((kind) => NC_SENSOR_TRANSITION_KINDS.includes(normaliseKind(kind)))
}

/** What an editor tells the operator when it is about to prune the choice. */
export const NC_SENSOR_TRANSITION_UNSUPPORTED_REASON =
  'Only a sensor that raises and clears (water, smoke, gas, CO, vibration, tamper, motion, contact) can fire on one edge. Pick only such sensor kinds, or the rule fires on every change.'
