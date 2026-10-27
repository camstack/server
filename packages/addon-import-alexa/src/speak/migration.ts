/**
 * Before one-account-one-broker, Speak on Echo kept its own Amazon login in the
 * addon settings. This decides what happens to that login and to the targets
 * built on it. It is pure; the controller applies the plan.
 *
 * - exactly one broker: the old jar and every target move onto it;
 * - no broker, or several: the old jar is dropped (it belongs to no named
 *   account) and the targets stay unassigned. The status then names the state,
 *   so the operator is told to sign in on a broker or to pick one per target.
 */
import type { AlexaSpeakSettings } from '../config.js'

export type SpeakTargetRow = AlexaSpeakSettings['targets'][number]

export interface LegacySpeakLogin {
  readonly email: string
  readonly password: string
  readonly session: string
}

export type SpeakNotice = '' | 'no-broker' | 'choose-broker'

export interface LegacyPlan {
  /** True when the settings still hold an old Speak login to drain. */
  readonly present: boolean
  /** The broker that inherits the old jar, or null when it is dropped. */
  readonly attachTo: string | null
  readonly targets: readonly SpeakTargetRow[]
}

export function legacyLoginOf(settings: AlexaSpeakSettings): LegacySpeakLogin {
  return { email: settings.email, password: settings.password, session: settings.session }
}

export function planLegacyMigration(
  legacy: LegacySpeakLogin,
  brokerIds: readonly string[],
  targets: readonly SpeakTargetRow[],
): LegacyPlan {
  const present = legacy.email.length > 0 || legacy.password.length > 0 || legacy.session.length > 0
  const only = brokerIds.length === 1 ? (brokerIds[0] ?? null) : null
  if (!present || only === null) return { present, attachTo: null, targets }
  return {
    present,
    attachTo: legacy.session.length > 0 ? only : null,
    targets: targets.map((row) => (row.brokerId.length > 0 ? row : { ...row, brokerId: only })),
  }
}

/** What the page must tell the operator about targets that name no account. */
export function noticeFor(
  targets: readonly SpeakTargetRow[],
  brokerIds: readonly string[],
): SpeakNotice {
  if (!targets.some((row) => row.brokerId.length === 0)) return ''
  if (brokerIds.length === 0) return 'no-broker'
  return brokerIds.length > 1 ? 'choose-broker' : ''
}

export function unassignedCount(targets: readonly SpeakTargetRow[]): number {
  return targets.filter((row) => row.brokerId.length === 0).length
}
