/**
 * The human state of a sensor, button or lock, in the notification language.
 *
 * The token is frozen on the row (`unlocked`, `open`, `pressed`). The word is
 * the alarm-change phrase for that kind when one exists (`alarm.change.*`,
 * device stripped), else `sensor.state.<token>`. A token nobody worded is
 * empty: the title keeps the device name and never invents a state (D393).
 */
import { conventionalEventVocabulary } from '@dominevo/types'
import type { NcTextCatalog } from './text-catalog.js'

/** Shared vocabulary kind of a short press (`event-vocabulary.ts`). */
const SHORT_PRESS = 'press'

/** The outbox field a row freezes, or nothing when the event named no state. */
export function frozenSensorState(
  sensorState: string | undefined,
  eventType: string | undefined,
): { readonly sensorState?: string } {
  const token = sensorStateToken(sensorState, eventType)
  return token === undefined ? {} : { sensorState: token }
}

/**
 * A slice word (`unlocked`, `open`) wins. A short press (`press`, `click`)
 * becomes `pressed`. Every other event token stays unstated.
 */
export function sensorStateToken(
  sensorState: string | undefined,
  eventType: string | undefined,
): string | undefined {
  if (sensorState !== undefined && sensorState.length > 0) return sensorState
  if (eventType === undefined || eventType.length === 0) return undefined
  const kind = conventionalEventVocabulary([eventType])[0]?.kind
  return kind === SHORT_PRESS ? 'pressed' : undefined
}

/** `unlocked` / `aperta` / `pressed`. Empty when this catalog has no word for the token. */
export function localizedSensorState(
  texts: NcTextCatalog,
  token: string | undefined,
  kind: string | undefined,
): string {
  if (token === undefined || token.length === 0) return ''
  const specific =
    kind !== undefined && kind.length > 0 && kind !== 'event'
      ? `alarm.change.${kind}.${token}`
      : undefined
  const keys = [specific, `alarm.change.${token}`, `sensor.state.${token}`]
  for (const key of keys) {
    if (key === undefined || !texts.has(key)) continue
    const phrase = texts.text({ key, vars: { device: '' } }).trim()
    if (phrase.length > 0) return phrase
  }
  return ''
}
