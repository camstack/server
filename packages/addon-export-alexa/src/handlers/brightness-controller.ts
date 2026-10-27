/**
 * `Alexa.BrightnessController/SetBrightness` handler.
 *
 * The Discovery handler declares `Alexa.BrightnessController` only on
 * child accessory endpoints that bind the `brightness` cap (today:
 * Reolink floodlights, Hikvision supplemental lights). Brightness is
 * NEVER exposed on the parent camera endpoint or on the synthetic
 * autotrack endpoint — both reject INVALID_DIRECTIVE here.
 *
 * Routing:
 *   - `${parent}__${child}` → `brightness.setBrightness({deviceId: child, level: percentage})`
 *
 * Auth: same scope-token verification path as the other controllers.
 * The response carries the `Alexa.BrightnessController.brightness`
 * property echoing the new level so the Echo updates its UI without an
 * extra ReportState round-trip.
 */

import type { AddonApi, AddonContext, IScopedLogger } from '@camstack/types'
import { z } from 'zod'
import type { VerifiedDirectiveIdentity } from '../directive-router.js'
import { parseCameraEndpointId } from './endpoint-id.js'
import { errorEnvelope } from './error-envelope.js'
import { type DirectiveHeader, EndpointRefSchema } from './types.js'

const SetBrightnessDirectiveSchema = z.object({
  header: z.object({
    namespace: z.literal('Alexa.BrightnessController'),
    name: z.literal('SetBrightness'),
  }),
  endpoint: EndpointRefSchema,
  payload: z.object({
    brightness: z.number().min(0).max(100),
  }),
})

export interface BrightnessControllerContext {
  readonly ctx: AddonContext
  readonly logger: IScopedLogger
}

export async function handleSetBrightness(
  header: DirectiveHeader,
  endpointRaw: unknown,
  payloadRaw: unknown,
  deps: BrightnessControllerContext,
  _callerIdentity: VerifiedDirectiveIdentity,
): Promise<unknown> {
  const parsed = SetBrightnessDirectiveSchema.safeParse({
    header: { namespace: header.namespace, name: header.name },
    endpoint: endpointRaw,
    payload: payloadRaw ?? {},
  })
  if (!parsed.success) {
    return errorEnvelope(
      header,
      'INVALID_DIRECTIVE',
      `payload validation failed: ${parsed.error.message}`,
    )
  }

  // Token is already verified by the centralized entry check in
  // handleDirective (http-server.ts). No per-handler re-verification needed.

  const endpointId = parsed.data.endpoint.endpointId
  const parsedId = parseCameraEndpointId(endpointId)
  if (
    parsedId.kind === 'autotrack' ||
    parsedId.kind === 'privacy' ||
    parsedId.kind === 'alarm-panel' ||
    parsedId.kind === 'detection'
  ) {
    return errorEnvelope(
      header,
      'INVALID_DIRECTIVE',
      `BrightnessController is not exposed on the ${parsedId.kind} endpoint`,
    )
  }
  if (parsedId.kind === 'camera') {
    return errorEnvelope(
      header,
      'INVALID_DIRECTIVE',
      'BrightnessController is not exposed on camera endpoints — direct the directive at the dimmable child accessory',
    )
  }
  if (parsedId.kind === 'invalid') {
    return errorEnvelope(header, 'INVALID_DIRECTIVE', parsedId.reason)
  }

  const percentage = parsed.data.payload.brightness
  const api: AddonApi = deps.ctx.api
  // An accessory child, or a light exported as its own device (R5).
  const targetDeviceId = parsedId.kind === 'child' ? parsedId.childDeviceId : parsedId.deviceId
  try {
    await api.brightness.setBrightness.mutate({
      deviceId: targetDeviceId,
      level: percentage,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    deps.logger.warn('alexa brightness-controller: setBrightness failed', {
      meta: { deviceId: targetDeviceId, percentage, error: message },
    })
    return errorEnvelope(header, 'INTERNAL_ERROR', `brightness.setBrightness failed: ${message}`)
  }

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
          namespace: 'Alexa.BrightnessController',
          name: 'brightness',
          value: percentage,
          timeOfSample: new Date().toISOString(),
          uncertaintyInMilliseconds: 500,
        },
      ],
    },
  }
}
