import { z } from 'zod'

/**
 * Wire shapes of the CCU management custom actions. Shared by the addon (handler
 * output validation) and the admin page (parsing what comes back), so the two
 * can never describe the same payload differently.
 *
 * A CCU write input always carries `confirmed: true`: the page asks the
 * operator first, and the handler refuses a call that did not say so.
 */

export const IntegrationRefSchema = z.object({ integrationId: z.string().min(1) })

/**
 * What the UI sends once the operator confirmed a CCU write. A boolean, not a
 * literal: the handler itself refuses `false` / absent with a named error
 * ({@link requireConfirmed}) instead of the schema's generic rejection.
 */
export const ConfirmedSchema = z.boolean()

export const CcuListItemSchema = z.object({
  integrationId: z.string(),
  name: z.string(),
  connected: z.boolean(),
})
export type CcuListItem = z.infer<typeof CcuListItemSchema>

export const CcuInfoSchema = z.object({
  version: z.string().nullable(),
  product: z.string().nullable(),
  productFamily: z.enum(['ccu3', 'openccu', 'unknown']),
  platform: z.string().nullable(),
  serial: z.string().nullable(),
  hostname: z.string().nullable(),
})

export const RadioGatewaySchema = z.object({
  address: z.string(),
  description: z.string().nullable(),
  dutyCycle: z.number().nullable(),
  connected: z.boolean().nullable(),
  isDefault: z.boolean(),
  firmware: z.string().nullable(),
  type: z.string().nullable(),
})

export const CcuInterfaceSchema = z.object({
  name: z.string(),
  port: z.number().nullable(),
  info: z.string().nullable(),
  connected: z.boolean().nullable(),
  dutyCycle: z.number().nullable(),
  firmware: z.string().nullable(),
  type: z.string().nullable(),
  gateways: z.array(RadioGatewaySchema),
})

/**
 * A section the CCU could not answer carries its reason instead of being
 * silently empty: "no WebUI credentials" and "nothing to report" must not look
 * the same.
 */
export const CcuOverviewSchema = z.object({
  info: CcuInfoSchema.nullable(),
  infoError: z.string().nullable(),
  interfaces: z.array(CcuInterfaceSchema),
  interfacesError: z.string().nullable(),
})
export type CcuOverview = z.infer<typeof CcuOverviewSchema>

export const ServiceMessageSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  address: z.string().nullable(),
  channel: z.number().nullable(),
  type: z.string().nullable(),
  timestamp: z.number().nullable(),
  acknowledgeable: z.boolean(),
})
export type ServiceMessage = z.infer<typeof ServiceMessageSchema>

export const ServiceMessagesResultSchema = z.object({
  messages: z.array(ServiceMessageSchema),
  error: z.string().nullable(),
})
export type ServiceMessagesResult = z.infer<typeof ServiceMessagesResultSchema>

export const AcknowledgeInputSchema = IntegrationRefSchema.extend({
  id: z.string().min(1),
  confirmed: ConfirmedSchema,
})

export const OkResultSchema = z.object({ ok: z.literal(true) })
