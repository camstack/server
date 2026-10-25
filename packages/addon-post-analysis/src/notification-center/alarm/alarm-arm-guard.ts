/**
 * WHICH devices must be secure before a mode can be armed — and what happens
 * when one of them is not.
 *
 * Coverage is derived from the SAME source `alarm-mode-coverage.ts` derives it
 * from: the enabled rules gated on `armed_<mode>` for this panel. A rule that
 * names a device is what makes that device part of the mode — a contact, a
 * window cover, a lock, a garage door alike (D630: whether it is an opening at
 * all is read from its runtime slices, `alarm-openings.ts`, not from the rule).
 * Nothing else is, and a second list on the panel would be right on the day it
 * was written and wrong the first time somebody disabled a rule (D62 — a switch
 * stores nothing and reads the authority that already owned the function).
 *
 * Getting past an open device is D630's: an explicit "Arm anyway" bound to the
 * refusal the operator was shown, plus a per-mode NON-BLOCKING list of devices
 * that may be open at arm time and are then armed excluded.
 *
 * Everything here is pure. Reading the device states, announcing the refusal
 * and holding the exclusions are the panel's and the centre's.
 */

import type { AlarmArmMode, NcConditions } from '@camstack/types'
import { z } from 'zod'
import { armedStateFor } from './alarm-mode-coverage.js'

/**
 * How long an Arm anyway stays pressable — the panel's refusal and the
 * button's grant TTL (`action-token.ts`) use this one constant. It lives here,
 * with the arm decision, so the token module does not import the device.
 */
export const ARM_ANYWAY_TTL_MS = 5 * 60_000

/**
 * The two fields of a rule this derivation reads.
 *
 * Narrowed rather than taking `NcRule`, for the same reason
 * {@link NcAlarmGatingRule} is: a real rule is structurally assignable to it,
 * so tests do not have to fabricate twenty fields no assertion looks at.
 */
export interface NcAlarmArmGatingRule {
  readonly enabled: boolean
  readonly conditions: Pick<NcConditions, 'deviceState' | 'devices' | 'devicesExclude'>
}

/**
 * One covered device that reads OPEN, with the name a person will read and the
 * word its cap reported (`open`, `stopped`, `unlocked`, …) — not only contacts:
 * a cover or a lock that is not secure is an opening too (D630).
 */
export const NcAlarmOpenDeviceSchema = z
  .object({
    deviceId: z.number().int(),
    name: z.string(),
    state: z.string(),
    /**
     * Cover / lock / switch — default false so an older bridge answer still
     * parses as a contact-style opening.
     */
    controllable: z.boolean().default(false),
    /** Opening cap that produced the reading; used to actuate secure-on-arm. */
    cap: z.enum(['contact', 'cover', 'lock-control', 'switch']).optional(),
  })
  .readonly()
export type NcAlarmOpenDevice = z.infer<typeof NcAlarmOpenDeviceSchema>

/** Why an Arm anyway was not honoured — see `NcAlarmPanelDevice.armAnyway`. */
export const NcAlarmArmAnywayRejectionSchema = z.enum([
  'unknown-refusal',
  'stale',
  'expired',
  'used',
])
export type NcAlarmArmAnywayRejection = z.infer<typeof NcAlarmArmAnywayRejectionSchema>

/**
 * What one arm attempt — plain or Arm anyway — came to.
 *
 * A schema, and it lives HERE, in the addon, because it is the response of the
 * `nc.armAlarm` / `nc.armAlarmAnyway` BRIDGE actions: the bridge validates
 * against the addon's own copy, so a refusal can travel as a result (its id and
 * the names of what is open) and the viewer can offer the Arm anyway bound to
 * it. The cap cannot: `alarm-panel.arm` answers `z.void()` on the HOST's router,
 * which is why the cap throws {@link NcAlarmArmRefusedError} instead.
 */
export const NcAlarmArmOutcomeSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.enum(['armed', 'arming']),
      excluded: z.array(NcAlarmOpenDeviceSchema).readonly(),
    })
    .readonly(),
  z
    .object({
      outcome: z.literal('refused'),
      refusalId: z.string(),
      blocking: z.array(NcAlarmOpenDeviceSchema).readonly(),
    })
    .readonly(),
  z.object({ outcome: z.literal('rejected'), reason: NcAlarmArmAnywayRejectionSchema }).readonly(),
  /** The mode has an activation schedule and `now` is outside it. */
  z.object({ outcome: z.literal('outside-schedule') }).readonly(),
])
export type NcAlarmArmOutcome = z.infer<typeof NcAlarmArmOutcomeSchema>

/**
 * The devices a mode covers, ascending and de-duplicated.
 *
 * A rule qualifies when it is enabled and gated on THIS panel in THIS mode;
 * every device it names is covered, whatever its kind. A camera it names is
 * covered too, and is simply never an opening (`alarmOpeningFrom` answers
 * `not-opening` for it, and the arm check skips it without a word).
 *
 * A rule with NO device scope contributes nothing: it covers every device on
 * the hub, and blocking on a set the operator never wrote down produces a
 * refusal naming devices they never associated with the alarm. The caller says
 * so in a log line rather than inventing the list.
 */
export function alarmCoveredDevices(
  rules: readonly NcAlarmArmGatingRule[],
  panelDeviceId: number,
  mode: AlarmArmMode,
): readonly number[] {
  const wanted = armedStateFor(mode)
  const ids = new Set<number>()
  for (const rule of rules) {
    if (!rule.enabled) continue
    const gate = rule.conditions.deviceState
    if (gate === undefined || gate.deviceId !== panelDeviceId) continue
    if (!gate.states.includes(wanted)) continue
    const scope = rule.conditions.devices
    if (scope === undefined || scope.length === 0) continue
    // D641: a rule never covers a device it excludes (a legacy rule with both).
    const excluded = rule.conditions.devicesExclude ?? []
    for (const id of scope) if (!excluded.includes(id)) ids.add(id)
  }
  return [...ids].toSorted((a, b) => a - b)
}

export interface NcAlarmArmDecisionInput {
  readonly mode: AlarmArmMode
  /** Covered devices reading OPEN now. */
  readonly open: readonly NcAlarmOpenDevice[]
  /** This mode's non-blocking ids (settings.nonBlocking) — contacts opt-out. */
  readonly nonBlocking: readonly number[]
  /**
   * Controllable openings that DO refuse when open (settings.blocking).
   * Controllable not on this list are tolerated (default: do not block).
   */
  readonly blocking?: readonly number[]
  /** Ids the operator was SHOWN and confirmed with Arm anyway; absent = a plain arm. */
  readonly acknowledged?: readonly number[]
}

/** What an arm attempt is allowed to do. */
export type NcAlarmArmVerdict =
  /** Arm, with these open devices excluded until they close and re-open. */
  | { readonly kind: 'arm'; readonly excluded: readonly NcAlarmOpenDevice[] }
  /** Something open is neither tolerated nor acknowledged. The panel does NOT move. */
  | { readonly kind: 'refused'; readonly blocking: readonly NcAlarmOpenDevice[] }

/**
 * Refuse or arm — the whole decision, as one partition of the open devices.
 *
 * A device may be open at arm time when:
 *  - the mode TOLERATES it (`nonBlocking` for contacts),
 *  - it is controllable and NOT on the mode's `blocking` list (default),
 *  - or the operator confirmed it with Arm anyway (`acknowledged`).
 *
 * Anything else open refuses — including a device that opened AFTER the refusal
 * the operator is confirming.
 *
 * Excluded is EVERY open device — tolerated and acknowledged alike — and the
 * exclusion is two-phase (`alarm-exclusions.ts`): each one is watched again
 * once it has closed and opened.
 */
export function decideArm(input: NcAlarmArmDecisionInput): NcAlarmArmVerdict {
  const forceBlock = new Set(input.blocking ?? [])
  const tolerated = new Set([...input.nonBlocking, ...(input.acknowledged ?? [])])
  for (const d of input.open) {
    if (d.controllable && !forceBlock.has(d.deviceId)) tolerated.add(d.deviceId)
  }
  const blocking = input.open.filter((d) => !tolerated.has(d.deviceId))
  if (blocking.length > 0) return { kind: 'refused', blocking }
  return { kind: 'arm', excluded: input.open }
}

/**
 * The error `alarmPanel.arm` throws when it refuses.
 *
 * A THROW and not a return value, and the reason is a train: the hub's
 * generated router validates this method's response against the HOST's copy of
 * the cap, which says `z.void()`. An addon that answered a structured refusal
 * would have it rejected by the router in front of it — so the refusal reaches
 * the caller as the one channel that already works across that boundary, and
 * the operator's PHONE gets the sentence (`alarm-arm-refused`, through the
 * ordinary outbox, with its own Arm anyway) rather than a UI error being the
 * only trace.
 *
 * The message is deliberately actionable and English (an exception message is
 * a developer/API surface; the notification is the operator's).
 */
export class NcAlarmArmRefusedError extends Error {
  readonly code = 'alarm-arm-refused'
  readonly mode: AlarmArmMode
  readonly blocking: readonly NcAlarmOpenDevice[]

  constructor(input: { mode: AlarmArmMode; blocking: readonly NcAlarmOpenDevice[] }) {
    const names = input.blocking.map((d) => d.name).join(', ')
    super(`arm refused — open: ${names}. Use "Arm anyway" to arm with them excluded.`)
    this.name = 'NcAlarmArmRefusedError'
    this.mode = input.mode
    this.blocking = input.blocking
  }
}
