/**
 * Which capability says what a device's STATE is, and how to read it.
 *
 * `deviceManager.loadRuntimeState` returns every cap's slice for a device,
 * keyed by the kebab-case cap name:
 *
 *   { 'device-status': { online: true }, switch: { on: true, … } }
 *
 * "The state of this device" is not a thing the platform models — a switch has
 * `on`, a contact has `entryOpen`, an alarm panel has `state`. So the mapping
 * is a TABLE, declared here, rather than a guess made at read time. An
 * unmapped cap yields no state, and no state never matches a gate: adding a cap
 * cannot silently change what an existing rule does.
 *
 * ORDER MATTERS. A device usually carries several of these slices (a switch is
 * also `device-status`), and the first match wins — so the list runs from most
 * specific to least. `device-status` is deliberately absent: "online" is not a
 * state a rule should gate on, and having it here would make every device match
 * the first entry and mask its real one.
 */

/** How one capability's slice collapses to a single comparable string. */
interface StateReader {
  /** kebab-case cap name, as `loadRuntimeState` keys it. */
  readonly cap: string
  /** Field inside that slice. */
  readonly field: string
  /**
   * Vocabulary a rule author writes. A boolean field becomes these two words,
   * in this order — `[whenTrue, whenFalse]`. Absent for a field that is already
   * a string (the alarm's `state`, the cover's `state`).
   */
  readonly booleanWords?: readonly [string, string]
}

/**
 * Most specific first. Extending this list is how a new device kind becomes
 * gateable; nothing else needs to change.
 */
export const DEVICE_STATE_READERS: readonly StateReader[] = [
  // The one this whole mechanism was built for.
  { cap: 'alarm-panel', field: 'state' },
  { cap: 'cover', field: 'state' },
  { cap: 'presence', field: 'state' },
  // The cap is `lock-control` with a string `state` (`lock-control.cap.ts`,
  // `LockControlStatusSchema`). The entry this replaced named a `lock` cap
  // with a boolean `locked` — a cap that does not exist — so every lock
  // collapsed to `undefined` and a lock gate never matched.
  { cap: 'lock-control', field: 'state' },
  { cap: 'contact', field: 'entryOpen', booleanWords: ['open', 'closed'] },
  { cap: 'switch', field: 'on', booleanWords: ['on', 'off'] },
  { cap: 'binary', field: 'on', booleanWords: ['on', 'off'] },
]

/**
 * Collapse a device's full runtime state to the one string a rule compares
 * against, or `undefined` when nothing in the table applies.
 *
 * `undefined` is the safe answer everywhere: the gate treats it as "does not
 * match", so a device whose kind we cannot read simply never arms a rule.
 */
export function readDeviceStateFrom(
  runtimeState: Readonly<Record<string, unknown>>,
): string | undefined {
  for (const reader of DEVICE_STATE_READERS) {
    const slice = runtimeState[reader.cap]
    if (slice === null || typeof slice !== 'object') continue
    const value = (slice as Record<string, unknown>)[reader.field]
    if (typeof value === 'string' && value.length > 0) return value
    if (typeof value === 'boolean' && reader.booleanWords !== undefined) {
      return value ? reader.booleanWords[0] : reader.booleanWords[1]
    }
  }
  return undefined
}

/**
 * The states a rule editor can offer for a device, given its runtime state.
 * Same table, same order — so the picker can never offer a value the gate
 * would not recognise.
 */
export function stateVocabularyFor(
  runtimeState: Readonly<Record<string, unknown>>,
  alarmStates: readonly string[] = [],
): readonly string[] {
  for (const reader of DEVICE_STATE_READERS) {
    const slice = runtimeState[reader.cap]
    if (slice === null || typeof slice !== 'object') continue
    if (reader.booleanWords !== undefined) return [...reader.booleanWords]
    // A string-valued state has an open vocabulary; the alarm's is known, and
    // is passed in rather than duplicated here.
    if (reader.cap === 'alarm-panel') return [...alarmStates]
    const current = (slice as Record<string, unknown>)[reader.field]
    return typeof current === 'string' ? [current] : []
  }
  return []
}
