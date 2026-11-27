/**
 * The Zigbee2MQTT frontend WebSocket API (`lib/extension/frontend.ts` of Zigbee2MQTT): one
 * socket at `/api`, optional `?token=<frontend.auth_token>`, every message a JSON
 * `{ topic, payload }` that mirrors the MQTT topic without the base prefix. Everything that comes
 * in is parsed here, at the boundary; nothing past this file sees an unvalidated shape.
 */
import { z } from 'zod'

export const Z2M_CLOSE_UNAUTHORIZED = 4401

/** One WebSocket message. `payload` is whatever the topic carries (an object, or a plain string). */
export const Z2mEnvelopeSchema = z.object({
  topic: z.string().min(1),
  payload: z.unknown(),
})
export type Z2mEnvelope = z.infer<typeof Z2mEnvelopeSchema>

const ScalarSchema = z.union([z.boolean(), z.string(), z.number()])
export type Z2mScalar = z.infer<typeof ScalarSchema>

/**
 * One `exposes` entry. A generic expose (`numeric`, `binary`, `enum`, `text`, `list`,
 * `composite`) carries a `property`; a specific one (`switch`, `light`, `cover`, `lock`, `climate`,
 * `fan`) carries `features`, each a generic expose.
 */
export const Z2mExposeSchema = z.object({
  type: z.string(),
  name: z.string().optional(),
  label: z.string().optional(),
  property: z.string().optional(),
  /** Bit 1 published, bit 2 settable, bit 4 gettable. */
  access: z.number().optional(),
  category: z.string().optional(),
  unit: z.string().optional(),
  value_min: z.number().optional(),
  value_max: z.number().optional(),
  value_step: z.number().optional(),
  value_on: ScalarSchema.optional(),
  value_off: ScalarSchema.optional(),
  value_toggle: ScalarSchema.optional(),
  values: z.array(z.string()).optional(),
  endpoint: z.string().optional(),
  get features() {
    return z.array(Z2mExposeSchema).optional()
  },
})
export type Z2mExpose = z.infer<typeof Z2mExposeSchema>

export const Z2mDeviceDefinitionSchema = z.object({
  model: z.string().optional(),
  vendor: z.string().optional(),
  description: z.string().optional(),
  exposes: z.array(Z2mExposeSchema).default([]),
  supports_ota: z.boolean().optional(),
})

export const Z2mDeviceTypeSchema = z.enum([
  'Coordinator',
  'Router',
  'EndDevice',
  'GreenPower',
  'Unknown',
])

/** One entry of `bridge/devices`. The coordinator is listed too. */
export const Z2mDeviceSchema = z.object({
  ieee_address: z.string().min(1),
  type: z.string(),
  network_address: z.number().optional(),
  friendly_name: z.string().min(1),
  disabled: z.boolean().optional(),
  supported: z.boolean().optional(),
  interview_completed: z.boolean().optional(),
  interviewing: z.boolean().optional(),
  power_source: z.string().nullish(),
  model_id: z.string().nullish(),
  manufacturer: z.string().nullish(),
  software_build_id: z.string().nullish(),
  definition: Z2mDeviceDefinitionSchema.nullish(),
})
export type Z2mDevice = z.infer<typeof Z2mDeviceSchema>

export const Z2mDevicesSchema = z.array(Z2mDeviceSchema)

export const Z2mBridgeInfoSchema = z.object({
  version: z.string().optional(),
  coordinator: z
    .object({ ieee_address: z.string(), type: z.string().optional() })
    .partial()
    .optional(),
  network: z
    .object({
      pan_id: z.number().optional(),
      extended_pan_id: z.union([z.string(), z.array(z.number())]).optional(),
      channel: z.number().optional(),
    })
    .optional(),
  permit_join: z.boolean().optional(),
  permit_join_end: z.number().nullish(),
  restart_required: z.boolean().optional(),
})
export type Z2mBridgeInfo = z.infer<typeof Z2mBridgeInfoSchema>

/** `bridge/state` is `{ state }`; older servers publish the bare string. */
export const Z2mBridgeStateSchema = z.union([
  z.object({ state: z.enum(['online', 'offline']) }),
  z.enum(['online', 'offline']),
])

export const Z2mAvailabilitySchema = Z2mBridgeStateSchema

/** `bridge/response/*`: `status` tells success, `transaction` ties it to the request. */
export const Z2mResponseSchema = z.object({
  status: z.enum(['ok', 'error']),
  data: z.unknown().optional(),
  error: z.string().optional(),
  transaction: z.string().optional(),
})
export type Z2mResponse = z.infer<typeof Z2mResponseSchema>

export const Z2mNetworkNodeSchema = z.object({
  ieeeAddr: z.string(),
  friendlyName: z.string(),
  type: z.string(),
  networkAddress: z.number().optional(),
  failed: z.array(z.string()).optional(),
  lastSeen: z.number().optional(),
})

export const Z2mNetworkLinkSchema = z.object({
  sourceIeeeAddr: z.string().optional(),
  targetIeeeAddr: z.string().optional(),
  source: z.object({ ieeeAddr: z.string() }).optional(),
  target: z.object({ ieeeAddr: z.string() }).optional(),
  linkquality: z.number().optional(),
  lqi: z.number().optional(),
  depth: z.number().optional(),
  routes: z.array(z.unknown()).optional(),
})

export const Z2mNetworkMapSchema = z.object({
  type: z.literal('raw'),
  value: z.object({
    nodes: z.array(Z2mNetworkNodeSchema),
    links: z.array(Z2mNetworkLinkSchema),
  }),
})
export type Z2mNetworkMap = z.infer<typeof Z2mNetworkMapSchema>

/** `update` block of a device state, published by the OTA extension. */
export const Z2mUpdateStateSchema = z.object({
  state: z.enum(['available', 'updating', 'idle', 'scheduled']),
  progress: z.number().optional(),
  remaining: z.number().optional(),
  installed_version: z.number().nullish(),
  latest_version: z.number().nullish(),
})
export type Z2mUpdateState = z.infer<typeof Z2mUpdateStateSchema>

export const Z2mOtaCheckSchema = z.object({
  id: z.string().optional(),
  update_available: z.boolean(),
})

export const Z2mStateSchema = z.record(z.string(), z.unknown())
export type Z2mState = z.infer<typeof Z2mStateSchema>

/** Parse the text of one WebSocket frame; null for anything that is not an envelope. */
export function parseEnvelope(text: string): Z2mEnvelope | null {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  const parsed = Z2mEnvelopeSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}

export const Z2M_BRIDGE_PREFIX = 'bridge/'
export const Z2M_RESPONSE_PREFIX = 'bridge/response/'
