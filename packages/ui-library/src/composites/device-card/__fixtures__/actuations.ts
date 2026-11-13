/**
 * Invented actuations for the card's History view. Times sit before the
 * ui:shots frozen clock (2026-10-09 09:31 UTC) so the relative labels stay put.
 */
import type { DeviceTransition } from '@camstack/types'

export const ACTUATION_FIXTURE_DEVICE_ID = 201

const FROZEN = Date.UTC(2026, 9, 9, 9, 31)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const user = {
  kind: 'user',
  userId: 'u-ada',
  username: 'Ada',
  credential: 'session',
} as const

function transition(
  id: string,
  ago: number,
  capName: string,
  field: string,
  from: DeviceTransition['from'],
  to: DeviceTransition['to'],
  outcome: DeviceTransition['outcome'],
  actor: DeviceTransition['actor'],
): DeviceTransition {
  return {
    id,
    deviceId: ACTUATION_FIXTURE_DEVICE_ID,
    at: FROZEN - ago,
    capName,
    field,
    from,
    to,
    outcome,
    actor,
  }
}

const FIRST_PAGE: readonly DeviceTransition[] = [
  transition('fx-fail', 10 * MINUTE, 'climate-control', 'target', 22, 30, 'failed', user),
  transition('fx-target', 2 * HOUR, 'climate-control', 'target', 28, 22, 'confirmed', user),
  transition('fx-mode', 5 * HOUR, 'climate-control', 'mode', 'auto', 'heat', 'confirmed', user),
  transition('fx-device', 20 * HOUR, 'climate-control', 'target', null, 21, 'unconfirmed', {
    kind: 'device',
  }),
  transition('fx-night', 26 * HOUR, 'switch', 'on', true, false, 'already', {
    kind: 'action',
    addonId: 'core-blocks',
    actionId: 'act-night',
    runId: 'run-9',
    automationId: 'auto-night',
  }),
]

const NEXT_PAGE: readonly DeviceTransition[] = [
  transition('fx-older', 4 * DAY, 'climate-control', 'mode', 'cool', 'auto', 'device', {
    kind: 'device',
  }),
]

export interface ActuationFixturePage {
  readonly transitions: readonly DeviceTransition[]
  readonly nextCursor: string | null
}

/** One page of `deviceTransitions.listTransitions`, keyed by cursor. */
export function actuationFixturePage(cursor: string | undefined): ActuationFixturePage {
  if (cursor === 'more') return { transitions: NEXT_PAGE, nextCursor: null }
  return { transitions: FIRST_PAGE, nextCursor: 'more' }
}
