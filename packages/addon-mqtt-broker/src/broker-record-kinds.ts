import { defineEntryKind, entryBody } from '@camstack/types'
import { z } from 'zod'
import { mqttOnboardDescriptorSchema } from './mqtt-external-broker-entry.js'

export const MQTT_BROKERS_OWNER = 'mqtt-broker'

export const MqttBrokerBodySchema = entryBody({
  url: z.string().min(1),
  username: z.string().optional(),
  password: z.string().optional().meta({ secret: true }),
  clientIdPrefix: z.string().optional(),
  onboard: mqttOnboardDescriptorSchema.optional(),
})
export type MqttBrokerBody = z.infer<typeof MqttBrokerBodySchema>

export const mqttBrokersEntryKind = defineEntryKind('brokers', {
  title: 'MQTT external brokers',
  schema: MqttBrokerBodySchema,
  writeTrigger: 'an operator adds or removes an external MQTT broker entry',
})
