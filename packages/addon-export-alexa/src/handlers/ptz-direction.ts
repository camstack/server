/**
 * `Alexa.ToggleController/{TurnOn,TurnOff}` handler — restricted to PTZ
 * directional instances (`ptz.panLeft` / `ptz.panRight` / `ptz.tiltUp`
 * / `ptz.tiltDown`). Every `TurnOn` is a `runPtzTravel` (ptz-travel.ts):
 * ~1 s of travel made of the driver's own self-terminating `ptz.move`
 * pulses — no `continuousMove`, timer or `stop`.
 *
 * The response is sent once the travel has finished (≈1 s, well inside
 * Alexa's 8 s deadline) and always reports `toggleState=OFF`: the toggle is
 * momentary, and OFF is the true state once the head has stopped. A failed
 * first pulse answers `INTERNAL_ERROR`; a later one is logged and the
 * directive still succeeds, because the head did move.
 *
 * `TurnOff` is a no-op (success response) — Alexa never delivers it in
 * normal momentary usage, but accept it for resilience.
 */

import type { AddonApi, AddonContext, IScopedLogger } from '@camstack/types'
import { z } from 'zod'
import type { VerifiedDirectiveIdentity } from '../directive-router.js'
import { parseCameraEndpointId } from './endpoint-id.js'
import { errorEnvelope } from './error-envelope.js'
import { runPtzTravel } from './ptz-travel.js'
import { type DirectiveHeader, EndpointRefSchema } from './types.js'

const ToggleDirectiveSchema = z.object({
  header: z.object({
    namespace: z.literal('Alexa.ToggleController'),
    name: z.enum(['TurnOn', 'TurnOff']),
    instance: z.string().optional(),
  }),
  endpoint: EndpointRefSchema,
})

const INSTANCE_TO_MOVE: Readonly<Record<string, { pan?: number; tilt?: number }>> = {
  'ptz.panLeft': { pan: -1 },
  'ptz.panRight': { pan: 1 },
  'ptz.tiltUp': { tilt: 1 },
  'ptz.tiltDown': { tilt: -1 },
}

export interface PtzDirectionContext {
  readonly ctx: AddonContext
  readonly logger: IScopedLogger
}

export async function handlePtzDirection(
  header: DirectiveHeader & { instance?: string },
  endpointRaw: unknown,
  deps: PtzDirectionContext,
  _callerIdentity: VerifiedDirectiveIdentity,
): Promise<unknown> {
  const parsed = ToggleDirectiveSchema.safeParse({
    header: { namespace: header.namespace, name: header.name, instance: header.instance },
    endpoint: endpointRaw,
  })
  if (!parsed.success) {
    return errorEnvelope(
      header,
      'INVALID_DIRECTIVE',
      `payload validation failed: ${parsed.error.message}`,
    )
  }

  const endpointId = parsed.data.endpoint.endpointId
  const parsedId = parseCameraEndpointId(endpointId)
  if (parsedId.kind !== 'camera') {
    return errorEnvelope(
      header,
      'INVALID_DIRECTIVE',
      `ToggleController is only supported on camera endpoints — got ${endpointId}`,
    )
  }

  const instance = parsed.data.header.instance
  if (!instance) {
    return errorEnvelope(header, 'INVALID_DIRECTIVE', 'ToggleController directive missing instance')
  }

  // TurnOff is a no-op for momentary toggles — succeed without driving
  // the PTZ. Alexa may emit it after a TurnOn to clean state up.
  if (parsed.data.header.name === 'TurnOff') {
    return successResponse(header, endpointId, 'OFF', instance)
  }

  const move = INSTANCE_TO_MOVE[instance]
  if (!move) {
    return errorEnvelope(
      header,
      'INVALID_DIRECTIVE',
      `ToggleController instance not supported: ${instance}`,
    )
  }

  const api: AddonApi = deps.ctx.api
  const deviceId = parsedId.deviceId
  try {
    const travel = await runPtzTravel(api.ptz, deviceId, move)
    if (travel.error) {
      deps.logger.warn('alexa ptz-direction: ptz.move failed mid-travel', {
        meta: {
          deviceId,
          instance,
          issued: travel.issued,
          pulses: travel.pulses,
          error: travel.error.message,
        },
      })
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    deps.logger.warn('alexa ptz-direction: ptz.move failed', {
      meta: { deviceId, instance, error: message },
    })
    return errorEnvelope(header, 'INTERNAL_ERROR', `ptz.move failed: ${message}`)
  }

  return successResponse(header, endpointId, 'OFF', instance)
}

function successResponse(
  header: DirectiveHeader,
  endpointId: string,
  toggleState: 'ON' | 'OFF',
  instance: string,
): unknown {
  return {
    event: {
      header: {
        namespace: 'Alexa',
        name: 'Response',
        messageId: header.messageId,
        correlationToken: header.correlationToken,
        payloadVersion: '3',
      },
      endpoint: { endpointId },
      payload: {},
    },
    context: {
      properties: [
        {
          namespace: 'Alexa.ToggleController',
          instance,
          name: 'toggleState',
          value: toggleState,
          timeOfSample: new Date().toISOString(),
          uncertaintyInMilliseconds: 500,
        },
      ],
    },
  }
}
