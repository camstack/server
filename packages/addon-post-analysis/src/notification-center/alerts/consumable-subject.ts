/**
 * A consumable EPISODE's name, and the thresholds the rule set asks for (D642).
 *
 * Before D642 one cluster-wide threshold judged every item, so an item had one
 * episode: `consumable:<deviceId>:<key>`. The threshold is now the RULE's, and
 * the ledger keeps one episode per threshold a rule asks for — each with its
 * own hysteresis, pending raise and reminder — named
 * `consumable@<threshold>:<deviceId>:<key>`.
 *
 * The threshold rides the FAMILY segment on purpose: the device id stays the
 * second segment (`alertSubjectDeviceId`, D636 — the log tag and the indexed
 * column read it), and the item key stays last and whole, whatever it holds.
 *
 * Pure. No clock, no I/O.
 */
import {
  consumableLowPercentOf,
  NC_CONSUMABLE_LOW_PERCENT_DEFAULT,
  NC_CONSUMABLE_SYSTEM_EVENT_KINDS,
  type NcRule,
} from '@camstack/types'

/** A consumable subject, read back into its parts. */
export interface NcConsumableSubjectParts {
  readonly thresholdPercent: number
  readonly deviceId: number
  readonly key: string
  /**
   * A pre-D642 row (`consumable:<id>:<key>`): judged at the cluster threshold,
   * which shipped as — and on this hub still was — the rule default.
   */
  readonly legacy: boolean
}

const FAMILY = 'consumable'

/** The episode of `key` on `deviceId`, judged at `thresholdPercent`. */
export function consumableSubject(thresholdPercent: number, deviceId: number, key: string): string {
  return `${FAMILY}@${String(thresholdPercent)}:${String(deviceId)}:${key}`
}

/** The pre-D642 subject of the same item — read only to carry it over. */
export function legacyConsumableSubject(deviceId: number, key: string): string {
  return `${FAMILY}:${String(deviceId)}:${key}`
}

/** `null` for a subject that is not a consumable's. */
export function parseConsumableSubject(subject: string): NcConsumableSubjectParts | null {
  const first = subject.indexOf(':')
  const second = first < 0 ? -1 : subject.indexOf(':', first + 1)
  if (first < 0 || second < 0) return null
  const family = subject.slice(0, first)
  const deviceId = Number(subject.slice(first + 1, second))
  const key = subject.slice(second + 1)
  if (!Number.isInteger(deviceId) || key.length === 0) return null
  if (family === FAMILY) {
    return { thresholdPercent: NC_CONSUMABLE_LOW_PERCENT_DEFAULT, deviceId, key, legacy: true }
  }
  if (!family.startsWith(`${FAMILY}@`)) return null
  const thresholdPercent = Number(family.slice(FAMILY.length + 1))
  if (!Number.isInteger(thresholdPercent)) return null
  return { thresholdPercent, deviceId, key, legacy: false }
}

/**
 * Every consumable threshold the rule set asks for, ascending.
 *
 * A rule asks when it is a system-event rule whose kinds include a consumable
 * kind — enabled or not: a disabled rule's episode stays PENDING (no rule
 * matched it) and is re-offered the moment the rule is switched back on
 * (D636), which is what that rule would have said had it been on. With no such
 * rule at all the default is still judged, so an episode exists for the first
 * rule an operator writes to hear (D636's "offered once per rule change").
 */
export function consumableThresholdCensus(rules: readonly NcRule[]): readonly number[] {
  const thresholds = new Set<number>()
  for (const rule of rules) {
    const condition = rule.conditions.systemEvent
    if (rule.delivery !== 'system-event' || condition === undefined) continue
    if (!condition.kinds.some((kind) => NC_CONSUMABLE_SYSTEM_EVENT_KINDS.includes(kind))) {
      continue
    }
    thresholds.add(consumableLowPercentOf(condition))
  }
  if (thresholds.size === 0) thresholds.add(NC_CONSUMABLE_LOW_PERCENT_DEFAULT)
  return [...thresholds].toSorted((a, b) => a - b)
}
