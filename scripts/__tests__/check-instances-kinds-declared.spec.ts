import { describe, expect, it } from 'vitest'
import type { DeviceAddonEntry } from '../check-integration-instances-declared.js'
import { findBothRoleViolations, findKindsViolations } from '../check-instances-kinds-declared.js'

function entry(id: string, capabilities: readonly string[], pkg = id): DeviceAddonEntry {
  return { id, pkg, capabilities }
}

const DUAL = ['integration-instances', 'broker', 'device-provider', 'device-adoption']

describe('check-instances-kinds-declared', () => {
  it('passes a dual addon whose kinds each name a declared function cap', () => {
    const source = `composeInstanceKinds([{ kind: { id: 'account', label: 'A', functionCap: 'broker' } },
      { kind: { id: 'integration', label: 'I', functionCap: 'device-provider' } }], base)`
    expect(findKindsViolations([entry('dual', DUAL)], () => source)).toEqual([])
  })

  it('refuses a dual addon that declares no kinds at all', () => {
    const found = findKindsViolations([entry('dual', DUAL)], () => 'const x = 1')
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('declares no instance kinds')
  })

  it('refuses a single-function addon (or one with no section cap) that declares no kinds', () => {
    for (const caps of [['integration-instances', 'device-provider'], ['integration-instances']]) {
      const found = findKindsViolations([entry('solo', caps)], () => 'const x = 1')
      expect(found.map((v) => v.message).join('\n')).toContain('declares no instance kinds')
    }
  })

  it('passes a single-kind addon that declares its one kind', () => {
    const source = `kinds: [{ id: 'connection', label: 'C', functionCap: 'device-provider' }]`
    expect(
      findKindsViolations(
        [entry('solo', ['integration-instances', 'device-provider'])],
        () => source,
      ),
    ).toEqual([])
  })

  it('refuses a functionCap the addon does not declare', () => {
    const source = `kinds: [{ id: 'a', label: 'A', functionCap: 'smtp-provider' }]`
    const found = findKindsViolations([entry('dual', DUAL)], () => source)
    expect(found.map((v) => v.message).join('\n')).toContain("functionCap 'smtp-provider'")
  })

  it('refuses a kinds[] entry that names an id and no functionCap, even for a single-function addon', () => {
    const source = `kinds: [{ id: 'a', label: 'A', functionCap: 'broker' }, { id: 'b', label: 'B' }]`
    const found = findKindsViolations(
      [entry('solo', ['integration-instances', 'broker'])],
      () => source,
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('no functionCap')
  })

  it('refuses a package where one RecordIntegrationInstances declares kinds and its sibling does not', () => {
    const source = `
      const a = new RecordIntegrationInstances(records, kindA, {
        description: { role: 'services', instanceMode: 'multiple', kind: 'a', canTest: false,
          kinds: [{ id: 'a', label: 'A', functionCap: 'device-provider' }] },
        configured: () => true,
      })
      const b = new RecordIntegrationInstances(records, kindB, {
        description: { role: 'services', instanceMode: 'multiple', kind: 'b', canTest: false },
        configured: () => true,
      })`
    const found = findKindsViolations(
      [entry('two', ['integration-instances', 'device-provider'])],
      () => source,
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('RecordIntegrationInstances construction')
  })

  it('follows a description passed as a module constant, and passes two providers that both declare kinds', () => {
    const source = `
      const D: IntegrationInstanceDescription = { role: 'services', kinds: [{ id: 'a', label: 'A', functionCap: 'device-provider' }] }
      new RecordIntegrationInstances(records, kindA, { description: D, configured: () => true })
      new RecordIntegrationInstances(records, kindB, { description: { kinds: [{ id: 'b', label: 'B', functionCap: 'device-provider' }] }, configured: () => true })`
    expect(
      findKindsViolations([entry('two', ['integration-instances', 'device-provider'])], () => source),
    ).toEqual([])
  })

  it('reads a package as one provider: the entries of one package share their sections', () => {
    const entries = [
      entry('ha', ['integration-instances', 'broker', 'device-provider'], 'ha'),
      entry('ha-export', ['integration-instances', 'device-export'], 'ha'),
    ]
    const source = `kinds: [{ id: 'a', label: 'A', functionCap: 'device-export' }, { id: 'b', label: 'B', functionCap: 'broker' }]`
    expect(findKindsViolations(entries, () => source)).toEqual([])
  })

  it('ignores an addon that holds no integration-instances', () => {
    expect(findKindsViolations([entry('plain', ['device-provider', 'broker'])], () => '')).toEqual(
      [],
    )
  })

  it("refuses the retired role 'both'", () => {
    const found = findBothRoleViolations([entry('x', DUAL)], () => "describe: { role: 'both' }")
    expect(found).toHaveLength(1)
    expect(findBothRoleViolations([entry('x', DUAL)], () => "role: 'devices'")).toEqual([])
  })
})
