import type { MqttHaDiscoveredEntity } from './mqtt-ha-discovery-types.js'

/**
 * In-memory inventory of MQTT HA discovery entities, keyed by broker then entityKey.
 */
export class MqttHaDiscoveryStore {
  private readonly byBroker = new Map<string, Map<string, MqttHaDiscoveredEntity>>()

  upsert(entity: MqttHaDiscoveredEntity): void {
    let bucket = this.byBroker.get(entity.brokerId)
    if (bucket === undefined) {
      bucket = new Map()
      this.byBroker.set(entity.brokerId, bucket)
    }
    bucket.set(entity.entityKey, entity)
  }

  remove(brokerId: string, entityKey: string): void {
    const bucket = this.byBroker.get(brokerId)
    if (bucket === undefined) return
    bucket.delete(entityKey)
    if (bucket.size === 0) this.byBroker.delete(brokerId)
  }

  listForBroker(brokerId: string): readonly MqttHaDiscoveredEntity[] {
    const bucket = this.byBroker.get(brokerId)
    if (bucket === undefined) return []
    return [...bucket.values()]
  }

  get(brokerId: string, entityKey: string): MqttHaDiscoveredEntity | null {
    return this.byBroker.get(brokerId)?.get(entityKey) ?? null
  }

  clearBroker(brokerId: string): void {
    this.byBroker.delete(brokerId)
  }

  listBrokerIds(): readonly string[] {
    return [...this.byBroker.keys()]
  }

  findByComponentObject(
    brokerId: string,
    component: string,
    objectId: string,
  ): MqttHaDiscoveredEntity | null {
    const bucket = this.byBroker.get(brokerId)
    if (bucket === undefined) return null
    for (const entity of bucket.values()) {
      if (entity.component === component && entity.objectId === objectId) return entity
    }
    return null
  }
}
