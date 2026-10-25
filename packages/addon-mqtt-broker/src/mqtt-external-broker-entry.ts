import { z } from 'zod'

export const mqttOnboardDescriptorSchema = z.object({
  port: z.number().int().min(1).max(65535),
  allowAnonymous: z.boolean(),
})

export const MqttExternalBrokerEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().min(1),
  username: z.string().optional(),
  password: z.string().optional().meta({ secret: true }),
  clientIdPrefix: z.string().optional(),
  onboard: mqttOnboardDescriptorSchema.optional(),
})

export type MqttExternalBrokerEntry = z.infer<typeof MqttExternalBrokerEntrySchema>
