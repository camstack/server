/**
 * The narrow slice of Google's smart-home fulfillment protocol this addon
 * speaks, expressed once.
 *
 * Kept local and narrow on purpose, for the same reason
 * `packages/addon-export-alexa/src/endpoints/types.ts` gives: the published
 * schema is far wider than anything we emit, and adopting a third-party SDK
 * would import a surface we do not implement and cannot test.
 *
 * Request shapes are ZOD, not interfaces — a fulfillment body arrives from the
 * public internet and is untrusted, so it is parsed at the boundary rather than
 * asserted. Response shapes are interfaces: we build them, so the compiler is
 * the only check they need.
 *
 * Reference: Google smart home intents — SYNC / QUERY / EXECUTE / DISCONNECT.
 */
import { z } from 'zod'

// ── Inbound (untrusted) ─────────────────────────────────────────────

/** `action.devices.SYNC` carries no payload. */
export const SyncInputSchema = z.object({
  intent: z.literal('action.devices.SYNC'),
})

export const QueryInputSchema = z.object({
  intent: z.literal('action.devices.QUERY'),
  payload: z.object({
    devices: z.array(z.object({ id: z.string() })),
  }),
})

export const ExecuteInputSchema = z.object({
  intent: z.literal('action.devices.EXECUTE'),
  payload: z.object({
    commands: z.array(
      z.object({
        devices: z.array(z.object({ id: z.string() })),
        execution: z.array(
          z.object({
            command: z.string(),
            /** Free-form per command; each trait validates the params it reads. */
            params: z.record(z.string(), z.unknown()).optional(),
          }),
        ),
      }),
    ),
  }),
})

export const DisconnectInputSchema = z.object({
  intent: z.literal('action.devices.DISCONNECT'),
})

export const FulfillmentInputSchema = z.discriminatedUnion('intent', [
  SyncInputSchema,
  QueryInputSchema,
  ExecuteInputSchema,
  DisconnectInputSchema,
])

/**
 * Google sends exactly one input today and the contract says to answer the
 * first; `inputs` stays an array because that is what is on the wire.
 */
export const FulfillmentRequestSchema = z.object({
  requestId: z.string(),
  inputs: z.array(FulfillmentInputSchema).min(1),
})

export type FulfillmentRequest = z.infer<typeof FulfillmentRequestSchema>
export type FulfillmentInput = z.infer<typeof FulfillmentInputSchema>
export type QueryInput = z.infer<typeof QueryInputSchema>
export type ExecuteInput = z.infer<typeof ExecuteInputSchema>

// ── Outbound ────────────────────────────────────────────────────────

/**
 * Every Google device type this addon can emit. A closed union rather than
 * `string`: a typo in a type urn produces a device Google silently ignores,
 * which is indistinguishable from "the operator never exposed it".
 */
export type GoogleDeviceType =
  | 'action.devices.types.LIGHT'
  | 'action.devices.types.SWITCH'
  | 'action.devices.types.LOCK'
  | 'action.devices.types.SHUTTER'

/** Every trait this addon can emit. Closed for the same reason. */
export type GoogleTraitName =
  | 'action.devices.traits.OnOff'
  | 'action.devices.traits.Brightness'
  | 'action.devices.traits.LockUnlock'
  | 'action.devices.traits.OpenClose'

export interface SyncDeviceName {
  readonly name: string
}

export interface SyncDeviceInfo {
  readonly manufacturer: string
  readonly model: string
}

export interface SyncDevice {
  readonly id: string
  readonly type: GoogleDeviceType
  readonly traits: readonly GoogleTraitName[]
  readonly name: SyncDeviceName
  /**
   * Always `false` in this addon, and that is a design decision rather than an
   * omission: proactive Report State is a HomeGraph API call, HomeGraph
   * authenticates with a service-account key, and this addon holds no Google
   * credential of any kind. Google polls QUERY instead.
   * See docs/decisions/adr-0269-a-google-export-that-holds-no-google-credential.md.
   */
  readonly willReportState: boolean
  readonly attributes?: Readonly<Record<string, unknown>>
  readonly deviceInfo: SyncDeviceInfo
}

export interface SyncResponsePayload {
  readonly agentUserId: string
  readonly devices: readonly SyncDevice[]
}

/** One entry of QUERY's `payload.devices` map. */
export interface QueryDeviceState {
  readonly online: boolean
  readonly status: 'SUCCESS' | 'OFFLINE' | 'ERROR'
  readonly errorCode?: string
  readonly [field: string]: unknown
}

export interface QueryResponsePayload {
  readonly devices: Readonly<Record<string, QueryDeviceState>>
}

export interface ExecuteCommandResult {
  readonly ids: readonly string[]
  readonly status: 'SUCCESS' | 'ERROR' | 'OFFLINE'
  readonly states?: Readonly<Record<string, unknown>>
  readonly errorCode?: string
}

export interface ExecuteResponsePayload {
  readonly commands: readonly ExecuteCommandResult[]
}

/**
 * Top-level failure. Google accepts `payload.errorCode` on every intent and
 * surfaces `authFailure` by prompting the user to re-link — which is exactly
 * what a revoked hub OAuth session should produce.
 */
export interface ErrorResponsePayload {
  readonly errorCode: GoogleErrorCode
  readonly debugString?: string
}

export type FulfillmentResponsePayload =
  | SyncResponsePayload
  | QueryResponsePayload
  | ExecuteResponsePayload
  | ErrorResponsePayload
  | Record<string, never>

export interface FulfillmentResponse {
  readonly requestId: string
  readonly payload: FulfillmentResponsePayload
}

/**
 * Google's documented EXECUTE error codes, restricted to the ones this addon
 * can actually produce. Named so a handler cannot invent a code the Assistant
 * does not recognise (an unknown code is spoken as a generic failure and is
 * indistinguishable from a bug).
 */
export type GoogleErrorCode =
  | 'deviceNotFound'
  | 'deviceOffline'
  | 'functionNotSupported'
  | 'notSupported'
  | 'valueOutOfRange'
  | 'authFailure'
  | 'protocolError'
