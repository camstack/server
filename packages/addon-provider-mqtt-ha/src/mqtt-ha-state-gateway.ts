import type { TopicPayloadReader } from './mqtt-ha-entity-codec.js'

export type MqttHaPublish = (input: {
  readonly brokerId: string
  readonly topic: string
  readonly payload: string
}) => Promise<void>

/** Called for each message on one of an entity's topics (state or availability). */
export type MqttHaEntityListener = (topic: string, payload: string) => void

/**
 * Live MQTT payloads keyed by (brokerId, topic), and the devices listening to
 * them by (brokerId, entityKey). The broker session writes every message;
 * a device decodes what it needs with its entities' own templates, so one
 * JSON state topic can feed a dozen entities without being parsed for them.
 */
export class MqttHaStateGateway {
  private readonly payloads = new Map<string, string>()
  private readonly listeners = new Map<string, Set<MqttHaEntityListener>>()
  private publishImpl: MqttHaPublish | null = null

  setPublisher(publish: MqttHaPublish): void {
    this.publishImpl = publish
  }

  private topicKey(brokerId: string, topic: string): string {
    return `${brokerId}\0${topic}`
  }

  recordMessage(brokerId: string, topic: string, payload: string): void {
    this.payloads.set(this.topicKey(brokerId, topic), payload)
  }

  readPayload(brokerId: string, topic: string): string | undefined {
    return this.payloads.get(this.topicKey(brokerId, topic))
  }

  readerFor(brokerId: string): TopicPayloadReader {
    return (topic) => this.readPayload(brokerId, topic)
  }

  /** Listen to the messages that reach one entity; returns the unsubscribe. */
  subscribeEntity(brokerId: string, entityKey: string, listener: MqttHaEntityListener): () => void {
    const key = this.topicKey(brokerId, entityKey)
    let set = this.listeners.get(key)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(key, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(key)
    }
  }

  notifyEntity(brokerId: string, entityKey: string, topic: string, payload: string): void {
    const set = this.listeners.get(this.topicKey(brokerId, entityKey))
    if (set === undefined) return
    for (const listener of [...set]) listener(topic, payload)
  }

  async publish(brokerId: string, topic: string, payload: string): Promise<void> {
    const publish = this.publishImpl
    if (publish === null) throw new Error('mqtt-ha: MQTT publisher not wired')
    await publish({ brokerId, topic, payload })
  }

  clearBroker(brokerId: string): void {
    const prefix = `${brokerId}\0`
    for (const k of this.payloads.keys()) {
      if (k.startsWith(prefix)) this.payloads.delete(k)
    }
  }
}

/** Process-wide gateway for the addon runner (one import addon instance). */
export const mqttHaStateGateway = new MqttHaStateGateway()
