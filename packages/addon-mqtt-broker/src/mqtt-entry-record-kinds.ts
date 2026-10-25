import { defineEntryKind, entryBody } from '@camstack/types'
import { z } from 'zod'

export const MQTT_BROKER_OWNER = 'mqtt-broker'

const aclAccessSchema = z.enum(['sub', 'pub', 'both'])

export const MqttClientBodySchema = entryBody({
  passwordHash: z.string(),
})
export type MqttClientBody = z.infer<typeof MqttClientBodySchema>

export const mqttClientEntryKind = defineEntryKind('mqtt-client', {
  title: 'MQTT embedded clients',
  schema: MqttClientBodySchema,
  writeTrigger: 'an operator adds or removes an embedded MQTT client credential',
})

export const MqttAclBodySchema = entryBody({
  username: z.string().min(1),
  topicPattern: z.string().min(1),
  access: aclAccessSchema,
})
export type MqttAclBody = z.infer<typeof MqttAclBodySchema>

export const mqttAclEntryKind = defineEntryKind('mqtt-acl-rule', {
  title: 'MQTT ACL rules',
  schema: MqttAclBodySchema,
  writeTrigger: 'an operator edits embedded broker ACL rules',
})
