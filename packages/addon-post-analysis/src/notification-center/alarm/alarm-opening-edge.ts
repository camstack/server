/**
 * Which way an OPENING moved, read off the slice one sensor event carries
 * (D630 "Alarm rules fire on the opening edge").
 *
 * A rule that belongs to the alarm fires when an opening OPENS — a contact
 * opens, a cover leaves closed, a lock unlocks — and never when it closes.
 *
 * Stateless on purpose: one state change is N SensorEvent rows (one per linked
 * camera), and a "previous reading" tracker would call the first row an edge
 * and the other N−1 steady — camera 2's alarm rule would lose the event. The
 * slice already says which way the device went, and the transition gate
 * upstream (`sensor-transition-gate.ts`) only lets a row through when the level
 * (the boolean, or a cover's state WORD) actually changed.
 *
 * What is open and what is secure is NOT decided here: it is
 * {@link alarmOpeningFromSensorEvent}'s table, the same one the arm check
 * reads. This file adds only the DIRECTION of a word that table calls open:
 * a word travelling towards secure (`closing`, `locking`) is a closing edge,
 * a halt or a fault (`stopped`, `jammed`) is `neither` — not an entry, so an
 * alarm rule does not fire on it, though the arm check still counts it as open
 * (a different question: "not secure" vs "just opened").
 *
 * `undefined` = this kind has no opening meaning, or the slice is unreadable
 * (D49 — never guessed). The caller then does not filter at all.
 */

import { alarmOpeningFromSensorEvent } from './alarm-openings.js'

export type NcSensorEdge = 'opening' | 'closing' | 'neither'

/** Open words (per the openings table) that are travelling towards secure. */
const TOWARD_SECURE: ReadonlySet<string> = new Set(['closing', 'locking'])

/** Open words that are a halt or a fault: neither an entry nor a close. */
const HALTED: ReadonlySet<string> = new Set(['stopped', 'jammed'])

/** Open words that ARE the opening: leaving closed / leaving locked, or a contact apart. */
const OPENING: ReadonlySet<string> = new Set([
  'open',
  'opening',
  'unlocked',
  'unlocking',
  'door-open',
])

export function sensorEdgeOf(
  kind: string,
  value: Readonly<Record<string, unknown>> | null,
): NcSensorEdge | undefined {
  const opening = alarmOpeningFromSensorEvent(kind, value)
  if (opening.kind !== 'reading') return undefined
  if (opening.reading === 'secure') return 'closing'
  if (TOWARD_SECURE.has(opening.state)) return 'closing'
  if (HALTED.has(opening.state)) return 'neither'
  if (OPENING.has(opening.state)) return 'opening'
  // A word the cap's schema accepts but this file has not been taught: no
  // direction is claimed, so the rule is not filtered (fails open towards
  // notifying, never towards silence).
  return undefined
}
