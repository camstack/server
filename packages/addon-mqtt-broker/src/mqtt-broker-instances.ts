/**
 * The MQTT brokers as `integration-instances` (D1013): one instance per `brokers` record. An
 * external broker is a URL; an ONBOARD broker (`onboard: true` on the create form) is a CamStack
 * `aedes` server on this hub: the create allocates its port (or honours the operator's) and the
 * addon spawns it from the record, the delete tears it down. Removing a broker an MQTT Discovery
 * integration still names is refused (D1012).
 */
import { randomUUID } from 'node:crypto'
import {
  type ConfigUISchema,
  guardBrokerDelete,
  type IIntegrationInstancesProvider,
  type InstanceChange,
  type IntegrationInstanceStatus,
  type IntegrationTestConnectionResult,
  isSecretFieldView,
  type MqttBrokerLiveStatus,
  type ListedFieldRow,
  REDACTED_SECRET,
  RecordIntegrationInstances,
  type RecordsAccess,
} from '@camstack/types'
import { type MqttBrokerBody, mqttBrokersEntryKind } from './broker-record-kinds.js'
import { mqttBrokerUsers } from './mqtt-broker-users.js'
import { buildOnboardEntry, isOnboardRequested, readOnboardPort } from './onboard-helpers.js'

export const MQTT_INSTANCE_KIND = 'mqtt'

/** The create-form keys that only mean "run an onboard broker"; the record keeps a descriptor. */
const ONBOARD_FORM_KEYS: ReadonlySet<string> = new Set(['onboard', 'port', 'allowAnonymous'])

export interface MqttProbeResult {
  readonly ok: boolean
  readonly latencyMs?: number
  readonly error?: string
}

/** What the addon knows about a broker right now: its onboard server, or the last probe. */
export interface MqttLiveState {
  /** The onboard `aedes` server of this broker when it is up, else null. */
  readonly onboard: { readonly connectedClients: number } | null
  /** The last background probe of an external broker; absent before the first one ran. */
  readonly probe?: {
    readonly status: MqttBrokerLiveStatus
    readonly latencyMs: number | null
    readonly error?: string
    readonly lastCheckedAt: number
  }
}

const PROBE_LABELS: Readonly<Record<MqttBrokerLiveStatus, string>> = {
  connected: 'Connected',
  disconnected: 'Disconnected',
  'auth-failed': 'Authentication failed',
  unreachable: 'Unreachable',
  'tls-error': 'TLS error',
}

/** The instance's health word: connected / auth-failed / unreachable / tls-error, latency, clients. */
export function mqttHealthOf(
  body: MqttBrokerBody,
  live: MqttLiveState,
  now: number,
): { readonly status: IntegrationInstanceStatus; readonly lastCheckedAt?: number } {
  if (body.enabled === false) return { status: { state: 'off', label: 'Switched off' } }
  if (body.onboard !== undefined) {
    return live.onboard === null
      ? { status: { state: 'error', label: 'Not listening' }, lastCheckedAt: now }
      : {
          status: {
            state: 'ok',
            label: 'Listening',
            detail: `${live.onboard.connectedClients} connected clients`,
          },
          lastCheckedAt: now,
        }
  }
  const probe = live.probe
  if (probe === undefined) return { status: { state: 'unknown', label: 'Not checked yet' } }
  const detail =
    probe.status === 'connected'
      ? probe.latencyMs !== null
        ? `${probe.latencyMs} ms`
        : undefined
      : probe.error
  return {
    status: {
      state: probe.status === 'connected' ? 'ok' : 'error',
      label: PROBE_LABELS[probe.status],
      ...(detail !== undefined ? { detail } : {}),
    },
    lastCheckedAt: probe.lastCheckedAt,
  }
}

export interface MqttInstancesDeps {
  /** The form: the create form (`null`), an external broker or an onboard one. */
  readonly formSchema: (id: string | null, onboard: boolean) => ConfigUISchema
  readonly listMqttHaInstances: () => Promise<readonly ListedFieldRow[]>
  /** A free TCP port for an onboard broker whose operator named none. */
  readonly freePort: () => Promise<number>
  readonly probe: (cfg: {
    readonly url: string
    readonly username?: string
    readonly password?: string
  }) => Promise<MqttProbeResult>
  /** Whether the onboard `aedes` server of this broker is up. */
  readonly onboardListening: (id: string) => boolean
  /** The live state of a broker, for its health word. */
  readonly liveState: (id: string) => MqttLiveState
  /** The addon re-applies its runtime (probe cache, onboard servers) from the records. */
  readonly onChanged: (id: string, change: InstanceChange) => Promise<void>
}

function withoutOnboardKeys(values: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([key]) => !ONBOARD_FORM_KEYS.has(key)))
}

function typedText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** A password the form really typed: not blank, not the redaction token, not the hidden view. */
function typedSecret(value: unknown): string | undefined {
  const text = typedText(value)
  return text === undefined || text === REDACTED_SECRET || isSecretFieldView(text)
    ? undefined
    : text
}

function resultOf(probe: MqttProbeResult): IntegrationTestConnectionResult {
  return probe.ok
    ? {
        success: true,
        status: 'validated',
        ...(probe.latencyMs !== undefined ? { latencyMs: probe.latencyMs } : {}),
      }
    : { success: false, status: 'rejected', error: probe.error ?? 'The broker did not answer' }
}

export function buildMqttBrokerInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: MqttInstancesDeps,
): IIntegrationInstancesProvider {
  const instances: RecordIntegrationInstances<MqttBrokerBody> = new RecordIntegrationInstances(
    records,
    mqttBrokersEntryKind,
    {
      description: {
        role: 'services',
        instanceMode: 'multiple',
        kind: 'brokers',
        canTest: true,
        kinds: [
          {
            id: MQTT_INSTANCE_KIND,
            label: 'MQTT broker',
            functionCap: 'broker',
            brokerKind: 'mqtt',
            canTest: true,
          },
        ],
      },
      formSchema: (id) => deps.formSchema(id, false),
      kindOf: () => MQTT_INSTANCE_KIND,
      initialBody: (name): MqttBrokerBody => ({ name, url: 'mqtt://' }),
      configured: (body) => body.url.trim().length > 0 && body.url.trim() !== 'mqtt://',
      health: (body, id) => mqttHealthOf(body, deps.liveState(id), Date.now()),
      onChanged: deps.onChanged,
      test: async ({ id, values }): Promise<IntegrationTestConnectionResult> => {
        if (id === null && isOnboardRequested(values)) {
          return {
            success: true,
            status: 'validated',
            detail: 'A free port is picked when the broker is created',
          }
        }
        const saved = id === null ? null : await instances.readResolved(id)
        if (saved?.body.onboard !== undefined) {
          return deps.onboardListening(saved.id)
            ? {
                success: true,
                status: 'validated',
                detail: `Listening on port ${saved.body.onboard.port}`,
              }
            : { success: false, status: 'rejected', error: 'The onboard broker is not listening' }
        }
        const url = typedText(values['url']) ?? saved?.body.url
        if (url === undefined || url === 'mqtt://') {
          return { success: false, status: 'rejected', error: 'Enter the broker URL first' }
        }
        const username = typedText(values['username']) ?? saved?.body.username
        const password = typedSecret(values['password']) ?? saved?.body.password
        return resultOf(
          await deps.probe({
            url,
            ...(username !== undefined ? { username } : {}),
            ...(password !== undefined ? { password } : {}),
          }),
        )
      },
    },
  )
  const base = instances.toProvider()

  /** Port, descriptor and URL of an onboard broker the form asked for. */
  const onboardValues = async (
    id: string,
    name: string,
    values: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> => {
    const port = readOnboardPort(values) ?? (await deps.freePort())
    const built = buildOnboardEntry({ id, name, port, settings: values })
    return { ...withoutOnboardKeys(values), url: built.url, onboard: built.onboard }
  }

  const withOnboard: IIntegrationInstancesProvider = {
    ...base,
    instanceFormSchema: async ({ id }) => {
      const saved = id === null ? null : await instances.getResolved(id)
      return deps.formSchema(id, saved?.onboard !== undefined)
    },
    createInstance: async (input) => {
      const values = input.values ?? {}
      if (!isOnboardRequested(values)) {
        return base.createInstance({ ...input, values: withoutOnboardKeys(values) })
      }
      const id = input.id ?? randomUUID()
      return base.createInstance({
        ...input,
        id,
        values: await onboardValues(id, input.name, values),
      })
    },
    updateInstance: async (input) => {
      if (!isOnboardRequested(input.values)) {
        return base.updateInstance({ ...input, values: withoutOnboardKeys(input.values) })
      }
      const current = await instances.getResolved(input.id)
      if (current === null) throw new Error(`mqtt-broker: broker '${input.id}' not found`)
      // The editor creates the broker empty and then sends the form: that is where "onboard" arrives.
      if (current.onboard !== undefined) {
        return base.updateInstance({ ...input, values: withoutOnboardKeys(input.values) })
      }
      return base.updateInstance({
        ...input,
        values: await onboardValues(input.id, input.name ?? current.name, input.values),
      })
    },
  }
  return guardBrokerDelete(withOnboard, () => mqttBrokerUsers(deps.listMqttHaInstances))
}
