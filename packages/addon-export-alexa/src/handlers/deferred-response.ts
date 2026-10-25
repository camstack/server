/**
 * Slow directives (D869) — a blind takes tens of seconds to reach the position
 * it was told to go to, and Alexa gives a directive a few seconds.
 *
 * Amazon's contract (alexa-response, "Asynchronous responses"): answer within
 * the window with `Alexa/DeferredResponse` carrying `estimatedDeferralInSeconds`,
 * then send the real `Alexa/Response` (or `Alexa/ErrorResponse`) through the
 * Event Gateway, with the directive's `correlationToken`, once the device got
 * there. This helper owns that sequence so a handler states only WHAT it
 * commands, HOW it reads the result back and WHEN that read means "arrived":
 *
 *   1. issue the command; a failure is answered now (nothing was started);
 *   2. poll the read-back for a short sync window — a cover already at the
 *      target, or a fast one, answers a plain `Alexa/Response`;
 *   3. otherwise answer `DeferredResponse` and keep polling in the background
 *      until the target is reached (async `Response`) or the timeout passes
 *      (async `ErrorResponse`, never a guessed state).
 *
 * A read that FAILS while waiting changes nothing (D49): it is one poll lost,
 * not an arrival and not a failure.
 */
import { randomUUID } from 'node:crypto'
import type { IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'
import { errorEnvelope } from './error-envelope.js'
import type { DirectiveHeader } from './types.js'

export interface ResponseProperty {
  readonly namespace: string
  readonly name: string
  readonly value: unknown
  readonly instance?: string
}

/** The asynchronous result handed to the Event Gateway. */
export type AsyncOutcome =
  | { readonly kind: 'response'; readonly properties: readonly ResponseProperty[] }
  | { readonly kind: 'error'; readonly type: string; readonly message: string }

export interface AsyncResponseInput {
  readonly userId: string
  readonly endpointId: string
  readonly correlationToken: string | undefined
  readonly outcome: AsyncOutcome
}

export interface DeferralDeps {
  /** Posts the asynchronous Response through the event gateway; true on 2xx. */
  readonly sendAsyncResponse: (input: AsyncResponseInput) => Promise<boolean>
  readonly logger: IScopedLogger
  /** Test seams; default to the real clock. */
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
}

export interface DeferralReading {
  readonly properties: readonly ResponseProperty[]
  readonly reached: boolean
}

export interface DeferralPlan {
  readonly header: DirectiveHeader
  readonly endpointId: string
  readonly userId: string
  readonly deviceId: number
  /** What the actuator is told. Resolves when the command was ACCEPTED. */
  readonly command: () => Promise<void>
  /** The properties Alexa should see now, and whether they show the target
   *  reached; null when unreadable right now. */
  readonly read: () => Promise<DeferralReading | null>
  /** Error answered when the command itself is refused. */
  readonly commandErrorType: string
}

/** How long a directive is answered synchronously before it is deferred. */
export const SYNC_WAIT_MS = 3_000
/** What a deferred directive tells Alexa to expect. */
export const ESTIMATED_DEFERRAL_SECONDS = 30
/** How long the actuator has to arrive before the async answer is an error. */
export const DEFERRAL_TIMEOUT_MS = 120_000
export const POLL_INTERVAL_MS = 1_000

function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function responseEnvelope(
  header: DirectiveHeader,
  endpointId: string,
  properties: readonly ResponseProperty[],
): unknown {
  const timeOfSample = new Date().toISOString()
  return {
    event: {
      header: {
        namespace: 'Alexa',
        name: 'Response',
        messageId: header.messageId,
        ...(header.correlationToken !== undefined
          ? { correlationToken: header.correlationToken }
          : {}),
        payloadVersion: '3',
      },
      endpoint: { endpointId },
      payload: {},
    },
    context: {
      properties: properties.map((p) => ({
        namespace: p.namespace,
        name: p.name,
        ...(p.instance !== undefined ? { instance: p.instance } : {}),
        value: p.value,
        timeOfSample,
        uncertaintyInMilliseconds: 500,
      })),
    },
  }
}

export function deferredResponseEnvelope(
  header: DirectiveHeader,
  estimatedDeferralInSeconds: number,
): unknown {
  return {
    event: {
      header: {
        namespace: 'Alexa',
        name: 'DeferredResponse',
        messageId: header.messageId,
        ...(header.correlationToken !== undefined
          ? { correlationToken: header.correlationToken }
          : {}),
        payloadVersion: '3',
      },
      payload: { estimatedDeferralInSeconds },
    },
  }
}

/** The body the Event Gateway receives for an asynchronous directive result. */
export function buildAsyncResponsePayload(opts: {
  readonly endpointId: string
  readonly correlationToken: string | undefined
  readonly outcome: AsyncOutcome
  readonly accessToken: string
}): unknown {
  const header = {
    namespace: 'Alexa',
    messageId: randomUUID(),
    ...(opts.correlationToken !== undefined ? { correlationToken: opts.correlationToken } : {}),
    payloadVersion: '3',
  }
  const endpoint = {
    scope: { type: 'BearerToken', token: opts.accessToken },
    endpointId: opts.endpointId,
  }
  if (opts.outcome.kind === 'error') {
    return {
      event: {
        header: { ...header, name: 'ErrorResponse' },
        endpoint,
        payload: { type: opts.outcome.type, message: opts.outcome.message },
      },
    }
  }
  const timeOfSample = new Date().toISOString()
  return {
    event: { header: { ...header, name: 'Response' }, endpoint, payload: {} },
    context: {
      properties: opts.outcome.properties.map((p) => ({
        namespace: p.namespace,
        name: p.name,
        ...(p.instance !== undefined ? { instance: p.instance } : {}),
        value: p.value,
        timeOfSample,
        uncertaintyInMilliseconds: 500,
      })),
    },
  }
}

/** Poll until the target is reached or `untilMs` passes; null = never reached. */
async function pollUntilReached(
  plan: DeferralPlan,
  deps: DeferralDeps,
  untilMs: number,
): Promise<readonly ResponseProperty[] | null> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? sleepFor
  for (;;) {
    const read = await plan.read().catch((err: unknown) => {
      deps.logger.debug('alexa deferred directive: read-back failed — polling on', {
        tags: { deviceId: plan.deviceId },
        meta: { error: errMsg(err) },
      })
      return null
    })
    if (read !== null && read.reached) return read.properties
    if (now() >= untilMs) return null
    await sleep(POLL_INTERVAL_MS)
  }
}

async function settleInBackground(plan: DeferralPlan, deps: DeferralDeps): Promise<void> {
  const now = deps.now ?? Date.now
  const arrived = await pollUntilReached(plan, deps, now() + DEFERRAL_TIMEOUT_MS)
  const outcome: AsyncOutcome =
    arrived === null
      ? {
          kind: 'error',
          type: 'INTERNAL_ERROR',
          message: `device ${plan.deviceId} did not reach the requested state within ${DEFERRAL_TIMEOUT_MS / 1000}s`,
        }
      : { kind: 'response', properties: arrived }
  if (arrived === null) {
    deps.logger.warn('alexa deferred directive: target not reached before the timeout', {
      tags: { deviceId: plan.deviceId },
      meta: { endpointId: plan.endpointId, directive: plan.header.name },
    })
  }
  const sent = await deps.sendAsyncResponse({
    userId: plan.userId,
    endpointId: plan.endpointId,
    correlationToken: plan.header.correlationToken,
    outcome,
  })
  if (!sent) {
    deps.logger.warn('alexa deferred directive: the asynchronous response was not delivered', {
      tags: { deviceId: plan.deviceId },
      meta: { endpointId: plan.endpointId, outcome: outcome.kind },
    })
  }
}

/**
 * Run a slow directive: the synchronous answer (`Response`, `DeferredResponse`
 * or `ErrorResponse`). The background settle is returned too so a spec — or a
 * shutdown — can await it; the router ignores it.
 */
export async function runWithDeferral(
  plan: DeferralPlan,
  deps: DeferralDeps,
): Promise<{ readonly body: unknown; readonly settled: Promise<void> | null }> {
  try {
    await plan.command()
  } catch (err) {
    const message = errMsg(err)
    deps.logger.warn(`alexa deferred directive: ${plan.header.name} command failed`, {
      tags: { deviceId: plan.deviceId },
      meta: { error: message },
    })
    return {
      body: errorEnvelope(
        plan.header,
        plan.commandErrorType,
        `${plan.header.name} failed: ${message}`,
      ),
      settled: null,
    }
  }
  const now = deps.now ?? Date.now
  const arrived = await pollUntilReached(plan, deps, now() + SYNC_WAIT_MS)
  if (arrived !== null) {
    return { body: responseEnvelope(plan.header, plan.endpointId, arrived), settled: null }
  }
  const settled = settleInBackground(plan, deps).catch((err: unknown) => {
    deps.logger.warn('alexa deferred directive: settling failed', {
      tags: { deviceId: plan.deviceId },
      meta: { error: errMsg(err) },
    })
  })
  return {
    body: deferredResponseEnvelope(plan.header, ESTIMATED_DEFERRAL_SECONDS),
    settled,
  }
}
