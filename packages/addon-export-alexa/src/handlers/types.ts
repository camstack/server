/**
 * Zod schemas for the subset of the Alexa Smart Home directive surface
 * that we actually parse hub-side. The Smart Home Skill API ships
 * thousands of optional fields per namespace — we only validate what
 * we read; everything else passes through as `unknown`.
 *
 * Reference: https://developer.amazon.com/en-US/docs/alexa/smarthome/smart-home-skill-api-message-reference.html
 */
import { z } from 'zod'

// ── Common header / endpoint ────────────────────────────────────────

/** A directive header carries namespace + name + token + correlation id. */
export const DirectiveHeaderSchema = z.object({
  namespace: z.string(),
  name: z.string(),
  payloadVersion: z.string(),
  messageId: z.string(),
  correlationToken: z.string().optional(),
  /** Instanced interfaces' directives carry it (`Alexa.DataController`, D779);
   *  the response echoes it. */
  instance: z.string().optional(),
})
export type DirectiveHeader = z.infer<typeof DirectiveHeaderSchema>

/** Scope carries the bearer token Alexa minted via our OAuth provider. */
export const BearerScopeSchema = z.object({
  type: z.literal('BearerToken'),
  token: z.string(),
})
export type BearerScope = z.infer<typeof BearerScopeSchema>

/** Endpoint reference inside a directive payload. */
export const EndpointRefSchema = z.object({
  endpointId: z.string(),
  scope: BearerScopeSchema.optional(),
  cookie: z.record(z.string(), z.string()).optional(),
})
export type EndpointRef = z.infer<typeof EndpointRefSchema>

// ── Discovery ───────────────────────────────────────────────────────

export const DiscoveryDirectiveSchema = z.object({
  header: DirectiveHeaderSchema.extend({
    namespace: z.literal('Alexa.Discovery'),
    name: z.literal('Discover'),
  }),
  payload: z.object({
    scope: BearerScopeSchema,
  }),
})
export type DiscoveryDirective = z.infer<typeof DiscoveryDirectiveSchema>

// ── Generic directive envelope (loose) ──────────────────────────────
//
// Used for namespaces we haven't implemented yet — we still need to
// pull `header.namespace` / `header.name` / `endpoint.scope.token` to
// decide whether to authorize + dispatch.
export const GenericDirectiveSchema = z.object({
  header: DirectiveHeaderSchema,
  endpoint: EndpointRefSchema.optional(),
  payload: z.unknown().optional(),
})
export type GenericDirective = z.infer<typeof GenericDirectiveSchema>

/** Envelope wrapping a directive on the Alexa→skill wire. */
export const DirectiveRequestSchema = z.object({
  directive: GenericDirectiveSchema,
})
export type DirectiveRequest = z.infer<typeof DirectiveRequestSchema>

// ── CameraStreamController ──────────────────────────────────────────

export const InitializeCameraStreamsPayloadSchema = z.object({
  cameraStreams: z
    .array(
      z.object({
        protocol: z.string(),
        resolution: z
          .object({
            width: z.number(),
            height: z.number(),
          })
          .optional(),
        authorizationType: z.string().optional(),
        videoCodec: z.string().optional(),
        audioCodec: z.string().optional(),
      }),
    )
    .optional(),
})
export type InitializeCameraStreamsPayload = z.infer<typeof InitializeCameraStreamsPayloadSchema>

// ── RTCSessionController ────────────────────────────────────────────

export const InitiateSessionWithOfferPayloadSchema = z.object({
  sessionId: z.string(),
  offer: z.object({
    format: z.string().optional(),
    value: z.string(),
  }),
})
export type InitiateSessionWithOfferPayload = z.infer<typeof InitiateSessionWithOfferPayloadSchema>

export const SessionDisconnectedPayloadSchema = z.object({
  sessionId: z.string(),
})
export type SessionDisconnectedPayload = z.infer<typeof SessionDisconnectedPayloadSchema>

// ── ModeController (PTZ preset) ─────────────────────────────────────

export const SetModePayloadSchema = z.object({
  mode: z.string(),
})
export type SetModePayload = z.infer<typeof SetModePayloadSchema>
