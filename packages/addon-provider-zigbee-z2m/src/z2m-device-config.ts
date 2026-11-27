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

/** The suffix of the equipment id of a device's firmware Update device: `<ieee>#update`. */
export const Z2M_UPDATE_SUFFIX = '#update'

export function updateEquipmentOf(ieee: string): string {
  return ieee + Z2M_UPDATE_SUFFIX
}

/** The IEEE address an Update device's equipment id names; null when it is not one. */
export function ieeeOfUpdateEquipment(equipment: string): string | null {
  return equipment.endsWith(Z2M_UPDATE_SUFFIX) && equipment.length > Z2M_UPDATE_SUFFIX.length
    ? equipment.slice(0, -Z2M_UPDATE_SUFFIX.length)
    : null
}

export const zigbeeUpdateSchema = z.object({
  equipment: z.string().min(1).describe('IEEE address of the device, then #update'),
  integrationId: z.string().min(1).describe('Owning integration'),
  system: z.literal(Z2M_SYSTEM).optional(),
})
