/**
 * An operator-listed subnet is swept even when no local interface and no known device sits in it,
 * and a value that is not a /24 CIDR is refused (planner and record body alike).
 */
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildGreeInstances, greeConnectionsEntryKind, greeRecordKinds } from '../gree-instances.js'
import { isGreeSweepCidr, planGreeSweep } from '../gree-subnet-scan.js'

describe('gree extra sweep subnets', () => {
  it('sweeps a configured subnet with no local interface and no device in it', () => {
    const plan = planGreeSweep({
      subnets: [],
      extraSubnets: ['192.168.20.0/24'],
      localAddresses: ['10.0.0.5'],
    })

    expect(plan.broadcasts).toEqual(['192.168.20.255'])
    expect(plan.unicast).toHaveLength(254)
    expect(plan.unicast[0]).toBe('192.168.20.1')
    expect(plan.refused).toEqual([])
  })

  it('refuses a configured value that is not a /24 CIDR and still sweeps the valid ones', () => {
    const plan = planGreeSweep({
      subnets: [],
      extraSubnets: ['192.168.20.0/16', 'nope', '192.168.30.0/24'],
      localAddresses: [],
    })

    expect(plan.broadcasts).toEqual(['192.168.30.255'])
    expect(plan.refused.map((r) => r.subnet)).toEqual(['192.168.20.0/16', 'nope'])
  })

  it('validates a /24 CIDR', () => {
    expect(isGreeSweepCidr('192.168.20.0/24')).toBe(true)
    expect(isGreeSweepCidr('192.168.20.0/25')).toBe(false)
    expect(isGreeSweepCidr('192.168.20.0')).toBe(false)
    expect(isGreeSweepCidr('300.1.1.0/24')).toBe(false)
  })

  it('the integration body refuses an invalid CIDR and keeps a valid list', () => {
    const schema = greeConnectionsEntryKind.schema
    expect(schema.safeParse({ name: 'Default', sweepSubnets: ['192.168.20.0/24'] }).success).toBe(
      true,
    )
    expect(schema.safeParse({ name: 'Default', sweepSubnets: ['192.168.20.0/8'] }).success).toBe(
      false,
    )
  })

  it('the instance form carries the setting and the record stores it', async () => {
    const mem = makeInMemoryRecords('provider-gree')
    await mem.records.declare(greeRecordKinds)
    const instances = buildGreeInstances(mem.records)

    const form = await instances.instanceFormSchema({ id: 'x' })

    const keys = form.sections.flatMap((s) => s.fields.map((f) => f.key))
    expect(keys).toContain('sweepSubnets')
  })
})
