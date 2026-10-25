import { describe, it, expect } from 'vitest'
import { createBroker } from '../moleculer/broker-factory.js'

describe('broker-factory', () => {
  it('creates a hub broker with MsgPack serializer', async () => {
    const broker = createBroker({ nodeID: 'test-hub', mode: 'hub' })
    expect(broker.serializer?.constructor.name).toBe('MsgPackSerializer')
    await broker.stop()
  })

  it('MsgPack round-trips Buffer without corruption', async () => {
    const broker = createBroker({ nodeID: 'test-hub-2', mode: 'hub' })
    const s = broker.serializer
    if (!s) throw new Error('serializer not configured on broker')
    const input = { data: Buffer.from([0, 1, 2, 255]), name: 'test' }
    const serialized = s.serialize(input, 'P')
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double: deserialize returns unknown
    const deserialized = s.deserialize(serialized, 'P') as { data: Buffer; name: string }
    expect(Buffer.isBuffer(deserialized.data)).toBe(true)
    expect(Buffer.compare(input.data, deserialized.data)).toBe(0)
    await broker.stop()
  })
})
