/**
 * Shared Alexa `Alexa/ErrorResponse` envelope builder.
 *
 * Certification checks the shape: `correlationToken` (set here) and
 * `endpoint` (set by `withErrorEndpoint` in the router) are both required.
 *
 * Lives in its own module so every handler (and the directive router)
 * can emit its own namespace-appropriate error without circular imports.
 */
import { z } from 'zod'
import type { DirectiveHeader } from './types.js'

const ErrorEnvelopeSchema = z.object({
  event: z.object({
    header: z.object({
      namespace: z.literal('Alexa'),
      name: z.literal('ErrorResponse'),
      messageId: z.string(),
      correlationToken: z.string().optional(),
      payloadVersion: z.literal('3'),
    }),
    endpoint: z.object({ endpointId: z.string() }).optional(),
    payload: z.object({
      type: z.string(),
      message: z.string(),
    }),
  }),
})
export type AlexaErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>

export function errorEnvelope(
  header: DirectiveHeader,
  type: string,
  message: string,
): AlexaErrorEnvelope {
  return {
    event: {
      header: {
        namespace: 'Alexa',
        name: 'ErrorResponse',
        messageId: header.messageId,
        // Required on every ErrorResponse to a directive that carried one
        // (alexa-errorresponse). The `endpoint` is added by the router, which
        // is the one place that holds the directive's endpoint for every path.
        ...(header.correlationToken !== undefined
          ? { correlationToken: header.correlationToken }
          : {}),
        payloadVersion: '3',
      },
      payload: { type, message },
    },
  }
}
