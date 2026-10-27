import mqtt, { type MqttClient } from 'mqtt'
import { errMsg, type IScopedLogger } from '@camstack/types'
import type { MqttHaDiscoveryStore } from './mqtt-ha-discovery-store.js'
import {
  parseDiscoveryConfigPayload,
  parseDiscoveryConfigTopic,
} from './mqtt-ha-discovery-parser.js'
import type { MqttHaStateGateway } from './mqtt-ha-state-gateway.js'
import { entityTopics } from './mqtt-ha-entity-codec.js'
import type { MqttHaDiscoveredEntity } from './mqtt-ha-discovery-types.js'

const DISCOVERY_SUBSCRIBE = 'homeassistant/+/+/config'

export interface BrokerConnectionDetails {
  readonly url: string
  readonly username?: string
  readonly password?: string
  readonly clientIdPrefix?: string
}

export type GetBrokerConnection = (brokerId: string) => Promise<BrokerConnectionDetails | null>

export interface MqttHaBrokerSessionDeps {
  readonly brokerId: string
  readonly getConnection: GetBrokerConnection
  readonly store: MqttHaDiscoveryStore
  readonly stateGateway: MqttHaStateGateway
  readonly logger: IScopedLogger
  readonly addonId: string
}

/**
 * One mqtt.js client per MQTT broker: listens for HA discovery configs and
 * subscribes to each entity's `state_topic`.
 */
export class MqttHaBrokerSession {
  private client: MqttClient | null = null
  /** entityKey → the topics it listens to (state, per-field, availability). */
  private readonly entityTopicList = new Map<string, readonly string[]>()
  /** topic → the entities listening to it (a JSON state topic feeds many). */
  private readonly topicEntities = new Map<string, Set<string>>()
  private running = false

  constructor(private readonly deps: MqttHaBrokerSessionDeps) {}

  get isConnected(): boolean {
    return this.client?.connected === true
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    await this.connect()
  }

  async stop(): Promise<void> {
    this.running = false
    const client = this.client
    this.client = null
    this.entityTopicList.clear()
    this.topicEntities.clear()
    if (client !== null) {
      await new Promise<void>((resolve) => {
        client.end(false, {}, () => resolve())
      })
    }
    this.deps.store.clearBroker(this.deps.brokerId)
    this.deps.stateGateway.clearBroker(this.deps.brokerId)
  }

  private async connect(): Promise<void> {
    const details = await this.deps.getConnection(this.deps.brokerId)
    if (details === null) {
      this.deps.logger.warn('mqtt-ha: broker config unavailable — session idle', {
        meta: { brokerId: this.deps.brokerId },
      })
      return
    }

    const clientId = `${details.clientIdPrefix ?? 'camstack-'}${this.deps.addonId}-${this.deps.brokerId}`

    const client = mqtt.connect(details.url, {
      username: details.username,
      password: details.password,
      clientId,
      reconnectPeriod: 5_000,
      connectTimeout: 10_000,
    })
    this.client = client

    client.on('connect', () => {
      this.deps.logger.info('mqtt-ha: MQTT connected', {
        meta: { brokerId: this.deps.brokerId },
      })
      client.subscribe(DISCOVERY_SUBSCRIBE, { qos: 0 }, (err) => {
        if (err !== undefined && err !== null) {
          this.deps.logger.warn('mqtt-ha: discovery subscribe failed', {
            meta: { brokerId: this.deps.brokerId, error: errMsg(err) },
          })
        }
      })
      for (const topic of this.topicEntities.keys()) {
        client.subscribe(topic, { qos: 0 })
      }
    })

    client.on('message', (topic, payloadBuf) => {
      const payload = payloadBuf.toString('utf8')
      this.handleMessage(topic, payload)
    })

    client.on('error', (err) => {
      this.deps.logger.warn('mqtt-ha: MQTT client error', {
        meta: { brokerId: this.deps.brokerId, error: errMsg(err) },
      })
    })

    client.on('close', () => {
      this.deps.logger.info('mqtt-ha: MQTT disconnected', {
        meta: { brokerId: this.deps.brokerId },
      })
    })
  }

  private handleMessage(topic: string, payload: string): void {
    const discovery = parseDiscoveryConfigTopic(topic)
    if (discovery !== null) {
      this.handleDiscoveryConfig(discovery.component, discovery.objectId, payload)
      return
    }
    const entityKeys = this.topicEntities.get(topic)
    if (entityKeys === undefined) return
    this.deps.stateGateway.recordMessage(this.deps.brokerId, topic, payload)
    for (const entityKey of [...entityKeys]) {
      this.deps.stateGateway.notifyEntity(this.deps.brokerId, entityKey, topic, payload)
    }
  }

  private handleDiscoveryConfig(component: string, objectId: string, payload: string): void {
    const parsed = parseDiscoveryConfigPayload({
      brokerId: this.deps.brokerId,
      component,
      objectId,
      payload,
    })
    if (parsed === 'remove') {
      const existing = this.deps.store.findByComponentObject(
        this.deps.brokerId,
        component,
        objectId,
      )
      if (existing !== null) {
        this.untrackEntity(existing.entityKey)
        this.deps.store.remove(this.deps.brokerId, existing.entityKey)
      }
      return
    }
    if (parsed === null) return

    this.deps.store.upsert(parsed)
    this.trackEntity(parsed)
  }

  /** (Re)subscribe the topics of one entity; an unchanged set is left alone. */
  private trackEntity(entity: MqttHaDiscoveredEntity): void {
    const next = entityTopics(entity)
    const prior = this.entityTopicList.get(entity.entityKey)
    if (prior !== undefined) {
      if (prior.length === next.length && prior.every((t, i) => t === next[i])) return
      this.untrackEntity(entity.entityKey)
    }
    this.entityTopicList.set(entity.entityKey, next)
    for (const topic of next) {
      let keys = this.topicEntities.get(topic)
      if (keys === undefined) {
        keys = new Set()
        this.topicEntities.set(topic, keys)
        this.client?.subscribe(topic, { qos: 0 })
      }
      keys.add(entity.entityKey)
    }
  }

  private untrackEntity(entityKey: string): void {
    const topics = this.entityTopicList.get(entityKey)
    if (topics === undefined) return
    this.entityTopicList.delete(entityKey)
    for (const topic of topics) {
      const keys = this.topicEntities.get(topic)
      if (keys === undefined) continue
      keys.delete(entityKey)
      if (keys.size === 0) {
        this.topicEntities.delete(topic)
        this.client?.unsubscribe(topic)
      }
    }
  }

  async publish(topic: string, payload: string): Promise<void> {
    const client = this.client
    if (client === null || !client.connected) {
      throw new Error('mqtt-ha: MQTT client not connected')
    }
    await new Promise<void>((resolve, reject) => {
      client.publish(topic, payload, { qos: 0 }, (err) => {
        if (err !== undefined && err !== null) reject(err)
        else resolve()
      })
    })
  }
}

export interface MqttHaBrokerSessionManagerDeps {
  readonly addonId: string
  readonly getConnection: GetBrokerConnection
  readonly store: MqttHaDiscoveryStore
  readonly stateGateway: MqttHaStateGateway
  readonly logger: IScopedLogger
}

export class MqttHaBrokerSessionManager {
  private readonly sessions = new Map<string, MqttHaBrokerSession>()

  constructor(private readonly deps: MqttHaBrokerSessionManagerDeps) {}

  async ensureSession(brokerId: string): Promise<MqttHaBrokerSession> {
    let session = this.sessions.get(brokerId)
    if (session === undefined) {
      session = new MqttHaBrokerSession({ ...this.deps, brokerId })
      this.sessions.set(brokerId, session)
      await session.start()
    }
    return session
  }

  getSession(brokerId: string): MqttHaBrokerSession | null {
    return this.sessions.get(brokerId) ?? null
  }

  async stopSession(brokerId: string): Promise<void> {
    const session = this.sessions.get(brokerId)
    if (session === undefined) return
    await session.stop()
    this.sessions.delete(brokerId)
  }

  async shutdownAll(): Promise<void> {
    const ids = [...this.sessions.keys()]
    for (const id of ids) {
      await this.stopSession(id)
    }
  }
}
