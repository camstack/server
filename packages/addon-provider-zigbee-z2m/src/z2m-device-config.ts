/**
 * Persisted config of the devices of an integration. Per-device configuration lives ONLY in
 * `ctx.settings.*DeviceStore` (D865); what is here is identity and the plan the device registered
 * its caps from, which a restart restores before the server has said anything.
 */
import { z } from 'zod'
import { Z2mPlanSchema } from './z2m-exposes.js'

export const Z2M_SYSTEM = 'provider-zigbee-z2m'
export const Z2M_GATEWAY_ID = 'gateway'

export const zigbeeGatewaySchema = z.object({
  equipment: z.literal(Z2M_GATEWAY_ID),
  integrationId: z.string().min(1).describe('Owning integration'),
  system: z.literal(Z2M_SYSTEM).optional(),
})

export const zigbeeDeviceSchema = z.object({
  /** `ieee_address`: the one thing Zigbee2MQTT never changes about a device. */
  equipment: z.string().min(1).describe('IEEE address of the device'),
  integrationId: z.string().min(1).describe('Owning integration'),
  system: z.literal(Z2M_SYSTEM).optional(),
  plan: Z2mPlanSchema.nullish(),
})
export type ZigbeeDeviceConfig = z.infer<typeof zigbeeDeviceSchema>
