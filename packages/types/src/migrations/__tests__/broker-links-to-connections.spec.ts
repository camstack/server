/**
 * The integration link moves OFF the broker record (D1011): every broker row that names an
 * integration becomes a `connections` record keyed by that integration id, then the field is
 * cleared on the broker. The fixture marks a field the migration does not know (`calendarIds`)
 * and a secret-free name, to prove the broker row survives the move intact.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineEntryKind, entryBody } from '../../records/entry-kind.js'
import { makeInMemoryRecords } from '../../records/in-memory-records.js'
import { declareBrokerLinkKind } from '../../addon/broker-link.js'
import {
  brokerLinkPortsOver,
  moveBrokerLinksToConnections,
} from '../broker-links-to-connections.js'

const brokersKind = defineEntryKind('brokers', {
  title: 'Brokers',
  schema: entryBody({
    integrationId: z.string().optional(),
    calendarIds: z.array(z.string()).optional(),
  }),
})
const connectionsKind = declareBrokerLinkKind({
  title: 'Integrations',
  writeTrigger: 'an operator links an integration to a broker',
})

async function world() {
  const memory = makeInMemoryRecords('x')
  await memory.records.declare({ brokers: brokersKind, connections: connectionsKind })
  const brokers = memory.records.kind(brokersKind)
  const connections = memory.records.kind(connectionsKind)
  const warnings: string[] = []
  const ports = brokerLinkPortsOver({ brokers, connections, warn: (m) => warnings.push(m) })
  return { brokers, connections, ports, warnings }
}

describe('moveBrokerLinksToConnections', () => {
  it('writes the connection under the integration id and clears the link, keeping the rest', async () => {
    const w = await world()
    await w.brokers.put(
      {
        id: 'alexa_002',
        data: { name: 'Home', integrationId: 'int_0035', calendarIds: ['marked'] },
      },
      { ifRev: 0 },
    )
    const result = await moveBrokerLinksToConnections(w.ports)
    expect(result.outcome).toBe('done')
    expect((await w.connections.get('int_0035'))?.data).toEqual({
      name: 'Home',
      brokerId: 'alexa_002',
    })
    const broker = (await w.brokers.get('alexa_002'))?.data
    expect(broker?.integrationId).toBeUndefined()
    expect(broker?.calendarIds).toEqual(['marked'])
    expect(broker?.name).toBe('Home')
  })

  it('is idempotent', async () => {
    const w = await world()
    await w.brokers.put(
      { id: 'alexa_002', data: { name: 'Home', integrationId: 'int_0035' } },
      { ifRev: 0 },
    )
    await moveBrokerLinksToConnections(w.ports)
    const again = await moveBrokerLinksToConnections(w.ports)
    expect(again.outcome).toBe('already-done')
    expect((await w.connections.get('int_0035'))?.data.brokerId).toBe('alexa_002')
  })

  it('never overwrites a connection that already names another broker, and keeps the link', async () => {
    const w = await world()
    await w.connections.put(
      { id: 'int_0035', data: { name: 'Mine', brokerId: 'alexa_009' } },
      { ifRev: 0 },
    )
    await w.brokers.put(
      { id: 'alexa_002', data: { name: 'Home', integrationId: 'int_0035' } },
      { ifRev: 0 },
    )
    await moveBrokerLinksToConnections(w.ports)
    expect((await w.connections.get('int_0035'))?.data.brokerId).toBe('alexa_009')
    expect((await w.brokers.get('alexa_002'))?.data.integrationId).toBe('int_0035')
    expect(w.warnings.join('\n')).toContain('int_0035')
  })

  it('counts and logs stray int_* broker rows without deleting them', async () => {
    const w = await world()
    await w.brokers.put({ id: 'int_0036', data: { name: 'stray' } }, { ifRev: 0 })
    await w.brokers.put({ id: 'alexa_002', data: { name: 'Home' } }, { ifRev: 0 })
    const result = await moveBrokerLinksToConnections(w.ports)
    expect(result.outcome).toBe('already-done')
    expect(await w.brokers.get('int_0036')).not.toBeNull()
    expect(w.warnings.join('\n')).toContain('int_0036')
    expect(result.summary).toMatchObject({ strayIntegrationRows: 1 })
  })
})
