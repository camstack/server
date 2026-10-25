/**
 * `Alexa.PowerController/{TurnOn,TurnOff}` handler.
 *
 * Routing decodes the endpoint id:
 *   - `${parent}__${child}` → call `switch.setState({deviceId: child, on})`
 *   - `${parent}__autotrack` → call `ptzAutotrack.setEnabled({deviceId: parent, enabled})`
 *   - `${parent}__privacy` → call `privacyMask.setMask({deviceId: parent, patch: { enabled } })`
 *   - `${deviceId}__alarm` → reject with INVALID_DIRECTIVE (an alarm panel
 *     arms through `Alexa.SecurityPanelController`, not a power switch)
 *   - `${deviceId}` (bare parent camera) → reject with INVALID_DIRECTIVE
 *     (we never expose PowerController on the camera itself).
 *
 * Auth: verify the directive's scope token (same as every other
 * controller).
 */

import type { AddonApi, AddonContext, IScopedLogger } from '@camstack/types'
import { z } from 'zod'
import type { VerifiedDirectiveIdentity } from '../directive-router.js'
import { parseCameraEndpointId } from './endpoint-id.js'
import { errorEnvelope } from './error-envelope.js'
import { type DirectiveHeader, EndpointRefSchema } from './types.js'

const PowerDirectiveSchema = z.object({
  header: z.object({
    namespace: z.literal('Alexa.PowerController'),
    name: z.enum(['TurnOn', 'TurnOff']),
  }),
  endpoint: EndpointRefSchema,
})

export interface PowerControllerContext {
  readonly ctx: AddonContext
  readonly logger: IScopedLogger
}

export async function handlePower(
  header: DirectiveHeader,
  endpointRaw: unknown,
  deps: PowerControllerContext,
  _callerIdentity: VerifiedDirectiveIdentity,
): Promise<unknown> {
  const parsed = PowerDirectiveSchema.safeParse({
    header: { namespace: header.namespace, name: header.name },
    endpoint: endpointRaw,
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
  const on = parsed.data.header.name === 'TurnOn'
  const api: AddonApi = deps.ctx.api

  if (parsedId.kind === 'autotrack') {
    await api.ptzAutotrack.setEnabled.mutate({
      deviceId: parsedId.parentDeviceId,
      enabled: on,
    })
  } else if (parsedId.kind === 'privacy') {
    await api.privacyMask.setMask.mutate({
      deviceId: parsedId.parentDeviceId,
      patch: { enabled: on },
    })
  } else if (parsedId.kind === 'child') {
    await api.switch.setState.mutate({ deviceId: parsedId.childDeviceId, on })
  } else if (parsedId.kind === 'camera') {
    return errorEnvelope(
      header,
      'INVALID_DIRECTIVE',
      'PowerController is not exposed on camera endpoints — direct the directive at the child accessory',
    )
  } else if (parsedId.kind === 'alarm-panel') {
    // An alarm panel arms and disarms through `Alexa.SecurityPanelController`.
    // Turning a security system "on" is not a thing this addon will guess at.
    return errorEnvelope(
      header,
      'INVALID_DIRECTIVE',
      'PowerController is not exposed on alarm-panel endpoints — use Alexa.SecurityPanelController',
    )
  } else if (parsedId.kind === 'generic') {
    // A switch, light or siren exported as its own device (R5).
    await api.switch.setState.mutate({ deviceId: parsedId.deviceId, on })
  } else if (parsedId.kind === 'detection') {
    return errorEnvelope(
      header,
      'INVALID_DIRECTIVE',
      'PowerController is not exposed on a detection sensor — it only reports',
    )
  } else {
    return errorEnvelope(header, 'INVALID_DIRECTIVE', parsedId.reason)
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
          namespace: 'Alexa.PowerController',
          name: 'powerState',
          value: on ? 'ON' : 'OFF',
          timeOfSample: new Date().toISOString(),
          uncertaintyInMilliseconds: 500,
        },
      ],
    },
  }
}
