/**
 * `Alexa.LockController/Lock|Unlock` on a lock exported as its own device
 * (R5, D775), through the `lock-control` cap.
 *
 * Amazon: answer `Alexa.Response` with `lockState` in the context when the
 * lock acts within 5 s. The cap's `lock` / `unlock` resolve when the command
 * was accepted, so the state is read back after it; a lock still in motion
 * reports the state it is moving to (Amazon has no `LOCKING`). `JAMMED` is
 * reported as a state, not an error (Amazon). Unlocking by voice is something
 * the user must enable in the Alexa app; the skill does not second-guess it.
 */
import type { AddonApi, AddonContext, IScopedLogger, LockState } from '@camstack/types'
import { LockControlStatusSchema } from '@camstack/types'
import { parseCameraEndpointId } from './endpoint-id.js'
import { errorEnvelope } from './error-envelope.js'
import type { DirectiveHeader } from './types.js'

export interface LockControllerContext {
  readonly ctx: AddonContext
  readonly logger: IScopedLogger
}

export type AlexaLockState = 'LOCKED' | 'UNLOCKED' | 'JAMMED'

/** The `lock-control` state as Alexa's `lockState`. */
export function alexaLockStateFor(state: LockState): AlexaLockState {
  switch (state) {
    case 'locked':
    case 'locking':
      return 'LOCKED'
    case 'unlocked':
    case 'unlocking':
    case 'door-open':
      return 'UNLOCKED'
    case 'jammed':
      return 'JAMMED'
  }
}

export async function readLockState(
  api: AddonApi,
  deviceId: number,
): Promise<AlexaLockState | null> {
  const raw: unknown = await api.lockControl.getStatus.query({ deviceId })
  const parsed = LockControlStatusSchema.pick({ state: true }).safeParse(raw)
  return parsed.success ? alexaLockStateFor(parsed.data.state) : null
}

export async function handleLock(
  header: DirectiveHeader,
  endpoint: { readonly endpointId: string } | undefined,
  deps: LockControllerContext,
): Promise<unknown> {
  if (endpoint === undefined) return errorEnvelope(header, 'INVALID_DIRECTIVE', 'missing endpoint')
  const parsed = parseCameraEndpointId(endpoint.endpointId)
  if (parsed.kind !== 'generic') {
    return errorEnvelope(header, 'INVALID_DIRECTIVE', 'LockController is only on a lock endpoint')
  }
  const lock = header.name === 'Lock'
  const api = deps.ctx.api
  try {
    if (lock) await api.lockControl.lock.mutate({ deviceId: parsed.deviceId })
    else await api.lockControl.unlock.mutate({ deviceId: parsed.deviceId })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    deps.logger.warn(`alexa lock-controller: ${header.name} failed`, {
      tags: { deviceId: parsed.deviceId },
      meta: { error: message },
    })
    return errorEnvelope(header, 'ENDPOINT_UNREACHABLE', `${header.name} failed: ${message}`)
  }
  const state =
    (await readLockState(api, parsed.deviceId).catch(() => null)) ?? (lock ? 'LOCKED' : 'UNLOCKED')
  deps.logger.info(`alexa lock-controller: ${header.name}`, {
    tags: { deviceId: parsed.deviceId },
    meta: { lockState: state },
  })
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
      endpoint: { endpointId: endpoint.endpointId },
      payload: {},
    },
    context: {
      properties: [
        {
          namespace: 'Alexa.LockController',
          name: 'lockState',
          value: state,
          timeOfSample: new Date().toISOString(),
          uncertaintyInMilliseconds: 500,
        },
      ],
    },
  }
}
