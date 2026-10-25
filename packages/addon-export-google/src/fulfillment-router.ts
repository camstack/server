/**
 * Intent dispatch for `POST /addon/export-google/fulfillment`.
 *
 * The bearer is verified ONCE by the HTTP layer and the identity is threaded
 * in — the same shape `addon-export-alexa` settled on, and for the same
 * reason: a per-handler re-verification is four chances to forget one.
 *
 * Scope enforcement lives here rather than in the HTTP layer because it is
 * per-intent: SYNC and QUERY read, EXECUTE writes, and a token that may only
 * `view` must be able to list and read without being able to actuate.
 */
import type { IScopedLogger, MethodAccess, TokenScope } from '@camstack/types'
import { scopesAllowDeviceCap } from '@camstack/types'

import type {
  FulfillmentResponse,
  FulfillmentResponsePayload,
  GoogleErrorCode,
} from './google-home/protocol.js'
import { FulfillmentRequestSchema } from './google-home/protocol.js'
import { type ExecuteDeps, handleExecute } from './intents/execute.js'
import { handleQuery, type QueryDeps } from './intents/query.js'
import { handleSync, type SyncDeps } from './intents/sync.js'

/** Identity produced by `oauthVerifyAccessToken` on the HTTP boundary. */
export interface VerifiedGoogleCaller {
  readonly userId: string
  readonly username: string
  readonly scopes: readonly TokenScope[]
}

export interface FulfillmentDeps {
  readonly logger: IScopedLogger
  readonly sync: SyncDeps
  readonly query: QueryDeps
  readonly execute: ExecuteDeps
  /** Called on every SYNC — Google's SYNC is the first thing a completed link
   *  does, so it is the only reliable "this account is linked" signal we get. */
  readonly recordLink: (caller: VerifiedGoogleCaller) => Promise<void>
  /** Called on DISCONNECT — Google has already dropped the link on its side. */
  readonly removeLink: (userId: string) => Promise<void>
}

export interface FulfillmentResult {
  readonly status: number
  readonly body: FulfillmentResponse
}

function errorResult(
  requestId: string,
  errorCode: GoogleErrorCode,
  debugString: string,
  status: number,
): FulfillmentResult {
  return { status, body: { requestId, payload: { errorCode, debugString } } }
}

function ok(requestId: string, payload: FulfillmentResponsePayload): FulfillmentResult {
  return { status: 200, body: { requestId, payload } }
}

function allows(caller: VerifiedGoogleCaller, access: MethodAccess): boolean {
  return scopesAllowDeviceCap(caller.scopes, access)
}

export async function handleFulfillment(
  rawBody: unknown,
  deps: FulfillmentDeps,
  caller: VerifiedGoogleCaller,
): Promise<FulfillmentResult> {
  const parsed = FulfillmentRequestSchema.safeParse(rawBody)
  if (!parsed.success) {
    deps.logger.warn('google fulfillment: rejected — body did not parse', {
      meta: { issue: parsed.error.issues[0]?.message ?? 'unknown' },
    })
    return errorResult('unknown', 'protocolError', 'fulfillment body shape unexpected', 400)
  }

  const { requestId, inputs } = parsed.data
  // Google sends exactly one input; the contract is to answer the first.
  const input = inputs[0]
  if (input === undefined) {
    return errorResult(requestId, 'protocolError', 'no inputs', 400)
  }

  switch (input.intent) {
    case 'action.devices.SYNC': {
      if (!allows(caller, 'view')) return authFailure(requestId, 'SYNC', deps, caller)
      await deps.recordLink(caller)
      return ok(requestId, await handleSync(caller.userId, deps.sync))
    }
    case 'action.devices.QUERY': {
      if (!allows(caller, 'view')) return authFailure(requestId, 'QUERY', deps, caller)
      return ok(requestId, await handleQuery(input, deps.query))
    }
    case 'action.devices.EXECUTE': {
      // `create`, not `view` — actuating is a write, and a read-only link must
      // not be able to unlock a door.
      if (!allows(caller, 'create')) return authFailure(requestId, 'EXECUTE', deps, caller)
      return ok(requestId, await handleExecute(input, deps.execute))
    }
    case 'action.devices.DISCONNECT': {
      deps.logger.info('google fulfillment: account unlinked by Google', {
        meta: { userId: caller.userId },
      })
      await deps.removeLink(caller.userId)
      return ok(requestId, {})
    }
    default: {
      const unreachable: never = input
      return errorResult(
        requestId,
        'protocolError',
        `unhandled intent ${JSON.stringify(unreachable)}`,
        400,
      )
    }
  }
}

function authFailure(
  requestId: string,
  intent: string,
  deps: FulfillmentDeps,
  caller: VerifiedGoogleCaller,
): FulfillmentResult {
  deps.logger.warn('google fulfillment: token lacks the scope this intent needs', {
    meta: { intent, userId: caller.userId },
  })
  return errorResult(requestId, 'authFailure', `token not authorized for ${intent}`, 200)
}
