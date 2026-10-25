/**
 * Extracted from NotificationCenter (injectTestEvent, captureLiveStill, pruneSyntheticMedia).
 * The class method forwards private state through {@link SyntheticEventHost}.
 */

import type { NcIncomingEvent, NcIntakeReport } from './event-intake.js'
import type { NcTestEventInput, NcTestEventResult } from './test-event.js'
import {
  SYNTHETIC_ID_PREFIX,
  buildSyntheticEvent,
  deriveSyntheticMedia,
  triggerCanCarryStill,
} from './test-event.js'
import type { IScopedLogger, MediaFileBytes } from '@camstack/types'
import { randomUUID } from 'node:crypto'

/**
 * How long a synthetic injection's live snapshot stays in RAM.
 *
 * Long enough to cover the drain tick plus the first handful of outbox
 * backoffs (5 s doubling to a 300 s cap), short enough that a forgotten test
 * cannot hold a JPEG for the life of the process. A row still retrying after
 * this loses its picture and ships text-only — the same degradation a real
 * event gets when its media never landed.
 */
export const SYNTHETIC_MEDIA_TTL_MS = 10 * 60_000
/**
 * What the synthetic producer needs from the outside world, and nothing more:
 * one photograph. Passed per call rather than held on the centre because the
 * only caller is the bridge action, and a dep that exists for one code path is
 * clearer at that path than in a constructor twelve hundred lines away.
 */
export interface NcTestInjectionDeps {
  readonly getSnapshot?: (
    deviceId: number,
  ) => Promise<{ readonly base64: string; readonly contentType: string } | null>
}

export interface SyntheticEventHost {
  captureLiveStill(deviceId: number, deps: NcTestInjectionDeps): Promise<Uint8Array | null>
  consumeEventAndReport(event: NcIncomingEvent): Promise<NcIntakeReport>
  readonly logger: IScopedLogger
  readonly now: () => number
  pruneSyntheticMedia(now: number): void
  readonly syntheticMedia: Map<
    string,
    { readonly files: readonly MediaFileBytes[]; readonly expiresAt: number }
  >
}

/**
 * The SYNTHETIC producer — an operator-driven event, through the whole path.
 *
 * It builds an envelope and calls {@link consumeEventAndReport}. That is the
 * entire integration: no bypass, no second matcher, no shortcut into the
 * dispatcher. What the operator receives on their phone was matched by
 * `evaluateRule`, enqueued into the durable outbox, drained by the ordinary
 * tick, given media by the ordinary ladders, degraded by the ordinary engine
 * and delivered by the ordinary notifier.
 *
 * What it does NOT do is persist the event. No track row, no object-event
 * row, no sensor row, no media blob — {@link syntheticMedia} is RAM with an
 * expiry. The outbox row is the exception that proves the rule: it is the
 * notification's delivery queue, not a record of the event, and it carries
 * `synthetic: true` so it can never be mistaken for one.
 */
export async function injectTestEvent(
  host: SyntheticEventHost,
  input: NcTestEventInput,
  deps: NcTestInjectionDeps = {},
): Promise<NcTestEventResult> {
  const now = host.now()
  host.pruneSyntheticMedia(now)
  const recordId = `${SYNTHETIC_ID_PREFIX}${randomUUID()}`
  const event = buildSyntheticEvent(input, recordId, now)
  const notes: string[] = []

  // The still, BEFORE the event is consumed: the outbox drains 2 s later and
  // must find the media already there. A camera that cannot be photographed
  // costs the picture, never the test — that is the same fail-closed contract
  // the gif and the clip follow.
  let still: NcTestEventResult['still'] = 'none'
  if (!triggerCanCarryStill(event.kind)) {
    still = 'unattachable'
    notes.push(
      `a ${event.kind} notification carries no still in production either — the payload freezes no media owner for this trigger, so nothing to attach is the honest result, not a limitation of the test`,
    )
  } else if (input.still === 'live') {
    const jpeg = await host.captureLiveStill(input.deviceId, deps)
    if (jpeg === null) {
      still = 'unavailable'
      notes.push('the camera returned no snapshot — the notification ships without a still')
    } else {
      const files = await deriveSyntheticMedia(jpeg, input.bbox, now)
      host.syntheticMedia.set(recordId, { files, expiresAt: now + SYNTHETIC_MEDIA_TTL_MS })
      still = 'live'
      if (input.bbox === undefined) {
        notes.push(
          'no bbox was given, so only the clean scene exists — a rule asking for the subject crop finds nothing, exactly as it would for a real event with no crop stored',
        )
      }
    }
  }

  if (input.bypassCooldown) notes.push('cooldown bypassed, and NOT consumed')
  if (input.bypassMute) notes.push('per-camera notification mute bypassed')
  if (!input.runActions) {
    notes.push('the rule’s onTrigger sequences were NOT run (nothing was actuated)')
  }

  host.logger.info('synthetic event injected', {
    tags: { deviceId: input.deviceId },
    meta: {
      eventId: recordId,
      synthetic: true,
      trigger: input.trigger,
      classes: input.classNames,
      zones: input.zones,
      still,
      ...(input.onlyRuleId !== undefined ? { onlyRuleId: input.onlyRuleId } : {}),
    },
  })

  const report = await host.consumeEventAndReport(event)
  if (report.droppedBy === 'no-candidate-rule') {
    notes.push(
      input.onlyRuleId !== undefined
        ? 'that rule is not enabled, or its delivery does not match this trigger'
        : `no enabled rule declares delivery "${report.delivery}"`,
    )
  }
  if (report.droppedBy === 'muted') {
    notes.push(
      'this camera is muted — nothing was evaluated. Re-run with the mute bypass to see the rule verdicts',
    )
  }
  if (report.droppedBy === 'evaluation-inactive') {
    notes.push('this node does not run rule evaluation — inject on the post-processing node')
  }
  // A grouped TEST closes inside the admission and reports the rows that close inserted,
  // so "matched but no row" is true exactly when the close inserted none.
  if (report.outcomes.every((o) => o.enqueued === 0) && report.outcomes.some((o) => o.matched)) {
    notes.push(
      'the rule matched but no row was enqueued — every target is opted out of this rule, or the rule addresses none',
    )
  }

  return {
    recordId,
    origin: 'synthetic',
    delivery: report.delivery,
    candidates: report.candidates,
    outcomes: report.outcomes.map((o) => ({
      ruleId: o.ruleId,
      ruleName: o.ruleName,
      matched: o.matched,
      ...(o.failedCondition !== undefined ? { failedCondition: o.failedCondition } : {}),
      ...(o.matchedOn !== undefined ? { matchedOn: [...o.matchedOn] } : {}),
      cooldown: o.cooldown,
      enqueued: o.enqueued,
      targetIds: [...o.targetIds],
    })),
    still,
    notes,
    ...(report.droppedBy !== undefined ? { droppedBy: report.droppedBy } : {}),
  }
}
/** One live frame, or null. Never throws into an injection. */
export async function captureLiveStill(
  host: SyntheticEventHost,
  deviceId: number,
  deps: NcTestInjectionDeps,
): Promise<Uint8Array | null> {
  const capture = deps.getSnapshot
  if (capture === undefined) return null
  try {
    const shot = await capture(deviceId)
    if (shot === null || shot.base64.length === 0) return null
    const buf = Buffer.from(shot.base64, 'base64')
    const bytes = new Uint8Array(buf.byteLength)
    bytes.set(buf)
    return bytes
  } catch (err) {
    host.logger.warn('synthetic injection could not photograph the camera', {
      tags: { deviceId },
      meta: { error: String(err) },
    })
    return null
  }
}
/** Drop expired synthetic stills. Called on every injection — there is no
 *  timer, because the map is empty except while a test is in flight. */
export function pruneSyntheticMedia(host: SyntheticEventHost, now: number): void {
  for (const [id, held] of host.syntheticMedia) {
    if (held.expiresAt <= now) host.syntheticMedia.delete(id)
  }
}
