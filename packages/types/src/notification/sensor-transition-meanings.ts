/**
 * WHAT "STARTS" AND "FINISHES" MEAN PER SENSOR KIND — the sentence behind the
 * generic "Notify when" choices (D640). The choice itself stays generic
 * (`raised` | `cleared`); a rule editor and the viewer read this table to say
 * what each edge is for the kinds the rule watches.
 *
 * Held to {@link NC_SENSOR_TRANSITION_KINDS} by the spec: a kind that gains a
 * raise without a phrase here fails the build. Pure, RN-safe.
 */

import { NC_SENSOR_TRANSITION_KINDS } from './sensor-raised.js'

/** One edge, in every locale the editors ship. */
export interface NcSensorTransitionPhrase {
  readonly en: string
  readonly it: string
}

/** What the raise ("starts") and the clear ("finishes") mean for one kind. */
export interface NcSensorTransitionMeaning {
  readonly starts: NcSensorTransitionPhrase
  readonly finishes: NcSensorTransitionPhrase
}

/** Locales a {@link NcSensorTransitionPhrase} carries. */
export type NcSensorTransitionLocale = keyof NcSensorTransitionPhrase

export const NC_SENSOR_TRANSITION_MEANINGS: Readonly<Record<string, NcSensorTransitionMeaning>> =
  Object.freeze({
    contact: {
      starts: { en: 'opened', it: 'si apre' },
      finishes: { en: 'closed', it: 'si chiude' },
    },
    'motion-sensor': {
      starts: { en: 'motion detected', it: 'movimento rilevato' },
      finishes: { en: 'motion stopped', it: 'movimento terminato' },
    },
    smoke: {
      starts: { en: 'smoke detected', it: 'fumo rilevato' },
      finishes: { en: 'smoke gone', it: 'fumo scomparso' },
    },
    flood: {
      starts: { en: 'water detected', it: 'acqua rilevata' },
      finishes: { en: 'dry again', it: 'di nuovo asciutto' },
    },
    gas: {
      starts: { en: 'gas detected', it: 'gas rilevato' },
      finishes: { en: 'gas gone', it: 'gas scomparso' },
    },
    'carbon-monoxide': {
      starts: { en: 'carbon monoxide detected', it: 'monossido rilevato' },
      finishes: { en: 'carbon monoxide gone', it: 'monossido scomparso' },
    },
    vibration: {
      starts: { en: 'vibration detected', it: 'vibrazione rilevata' },
      finishes: { en: 'vibration stopped', it: 'vibrazione terminata' },
    },
    tamper: {
      starts: { en: 'tampered with', it: 'manomesso' },
      finishes: { en: 'tamper cleared', it: 'manomissione rientrata' },
    },
    'appliance-cycle': {
      starts: { en: 'the cycle started', it: 'il ciclo parte' },
      finishes: { en: 'the cycle finished', it: 'il ciclo è terminato' },
    },
  } satisfies Record<string, NcSensorTransitionMeaning>)

/** The meaning of one kind; `undefined` for a kind with no raise. */
export function sensorTransitionMeaning(kind: string): NcSensorTransitionMeaning | undefined {
  const key = kind.trim().toLowerCase()
  return NC_SENSOR_TRANSITION_KINDS.includes(key) ? NC_SENSOR_TRANSITION_MEANINGS[key] : undefined
}
