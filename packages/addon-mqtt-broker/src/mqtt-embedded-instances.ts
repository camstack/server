/**
 * The embedded broker's client credentials and topic ACL as `integration-instances` kinds (D1013).
 *
 * Two kinds of the addon's one provider, each over its own record kind: an `mqtt-client` is a
 * username with a bcrypt hash, an `mqtt-acl-rule` a username, a topic pattern and an access mode.
 * Every onboard broker shares them. An instance's own switch turns it off: a switched-off client
 * does not authenticate, a switched-off rule is not evaluated.
 */
import {
  type ConfigUISchema,
  type IntegrationInstanceKind,
  RecordIntegrationInstances,
  type RecordsAccess,
  type ResolvedInstance,
} from '@camstack/types'
import {
  type MqttAclBody,
  mqttAclEntryKind,
  type MqttClientBody,
  mqttClientEntryKind,
} from './mqtt-entry-record-kinds.js'

export const MQTT_CLIENT_INSTANCE_KIND = 'client'
export const MQTT_ACL_INSTANCE_KIND = 'acl-rule'

export const MQTT_CLIENT_KIND: IntegrationInstanceKind = {
  id: MQTT_CLIENT_INSTANCE_KIND,
  label: 'Embedded broker client',
  functionCap: 'broker',
  role: 'services',
  canTest: false,
}

export const MQTT_ACL_KIND: IntegrationInstanceKind = {
  id: MQTT_ACL_INSTANCE_KIND,
  label: 'Embedded broker topic rule',
  functionCap: 'broker',
  role: 'services',
  canTest: false,
}

const CLIENT_FORM: ConfigUISchema = {
  sections: [
    {
      id: 'mqtt-client',
      title: 'Client credentials',
      description:
        'The instance name is the username. Paste the bcrypt hash of the password (cost factor 10, for example from `npx bcrypt-cli`).',
      columns: 1,
      fields: [
        {
          type: 'text',
          key: 'passwordHash',
          label: 'bcrypt hash',
          description: 'bcrypt hash of the password (cost factor 10).',
          required: true,
        },
      ],
    },
  ],
}

const ACL_FORM: ConfigUISchema = {
  sections: [
    {
      id: 'mqtt-acl-rule',
      title: 'Topic rule',
      description:
        'With zero rules the broker is open to authenticated clients. With at least one rule, every user needs a rule that matches the topic.',
      columns: 1,
      fields: [
        { type: 'text', key: 'username', label: 'Username', required: true },
        {
          type: 'text',
          key: 'topicPattern',
          label: 'Topic pattern',
          description: 'MQTT wildcards: `+` = single level, `#` = multi-level.',
          required: true,
        },
        {
          type: 'select',
          key: 'access',
          label: 'Access',
          options: [
            { value: 'sub', label: 'Subscribe only' },
            { value: 'pub', label: 'Publish only' },
            { value: 'both', label: 'Subscribe + publish' },
          ],
        },
      ],
    },
  ],
}

export interface MqttEmbeddedInstancesDeps {
  /** The shared credentials or the ACL changed: reload them and hot-reload every onboard broker. */
  readonly onChanged: () => Promise<void>
}

export function buildMqttClientInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: MqttEmbeddedInstancesDeps,
): RecordIntegrationInstances<MqttClientBody> {
  return new RecordIntegrationInstances(records, mqttClientEntryKind, {
    description: {
      role: 'services',
      instanceMode: 'multiple',
      kind: MQTT_CLIENT_INSTANCE_KIND,
      canTest: false,
      kinds: [MQTT_CLIENT_KIND],
    },
    formSchema: () => CLIENT_FORM,
    kindOf: () => MQTT_CLIENT_INSTANCE_KIND,
    initialBody: (name): MqttClientBody => ({ name, passwordHash: '' }),
    configured: (body) => body.passwordHash.length > 0,
    onChanged: deps.onChanged,
  })
}

export function buildMqttAclInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: MqttEmbeddedInstancesDeps,
): RecordIntegrationInstances<MqttAclBody> {
  return new RecordIntegrationInstances(records, mqttAclEntryKind, {
    description: {
      role: 'services',
      instanceMode: 'multiple',
      kind: MQTT_ACL_INSTANCE_KIND,
      canTest: false,
      kinds: [MQTT_ACL_KIND],
    },
    formSchema: () => ACL_FORM,
    kindOf: () => MQTT_ACL_INSTANCE_KIND,
    // The name typed on Add is the user the rule is for; the form changes it.
    initialBody: (name): MqttAclBody => ({
      name,
      username: name,
      topicPattern: '#',
      access: 'both',
    }),
    configured: (body) => body.username.length > 0 && body.topicPattern.length > 0,
    onChanged: deps.onChanged,
  })
}

/** A client the embedded broker authenticates: the instance name is the username. */
export interface EmbeddedClientEntry {
  readonly username: string
  readonly passwordHash: string
}

export interface EmbeddedAclEntry {
  readonly username: string
  readonly topicPattern: string
  readonly access: MqttAclBody['access']
}

/** The clients that may authenticate: switched on, with a hash. */
export function activeClients(
  rows: readonly ResolvedInstance<MqttClientBody>[],
): readonly EmbeddedClientEntry[] {
  return rows
    .filter((row) => row.enabled && row.body.passwordHash.length > 0)
    .map((row) => ({
      username: row.body.name,
      passwordHash: row.body.passwordHash,
    }))
}

/** The rules that are evaluated: switched on, complete. */
export function activeAcl(
  rows: readonly ResolvedInstance<MqttAclBody>[],
): readonly EmbeddedAclEntry[] {
  return rows
    .filter((row) => row.enabled && row.body.username.length > 0)
    .map((row) => ({
      username: row.body.username,
      topicPattern: row.body.topicPattern,
      access: row.body.access,
    }))
}
