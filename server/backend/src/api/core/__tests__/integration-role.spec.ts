import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bringsDevices, describedRoleOf, resolveIntegrationRole } from '../integration-role.js'
import { INTEGRATION_CAP_MARKERS } from '../cap-providers.js'

describe('resolveIntegrationRole', () => {
  it('derives services from integration-instances and devices otherwise', () => {
    expect(
      resolveIntegrationRole({
        capabilities: [{ name: 'integration-instances' }],
      }),
    ).toBe('services')
    expect(resolveIntegrationRole({ capabilities: ['device-provider'] })).toBe('devices')
  })

  it('an explicit role wins over the derivation', () => {
    const role = resolveIntegrationRole({
      integrationRole: 'devices',
      capabilities: ['integration-instances', 'device-provider'],
    })
    expect(role).toBe('devices')
    expect(bringsDevices(role)).toBe(true)
    expect(bringsDevices('services')).toBe(false)
  })
})

describe('describedRoleOf', () => {
  it('is devices as soon as one kind brings devices, whatever the provider role', () => {
    const kinds = [
      { id: 'account', label: 'A', functionCap: 'broker', role: 'services' as const },
      { id: 'integration', label: 'I', functionCap: 'device-provider', role: 'devices' as const },
    ]
    expect(describedRoleOf({ role: 'services', kinds })).toBe('devices')
    expect(describedRoleOf({ role: 'services', kinds: [kinds[0]!] })).toBe('services')
  })

  it('a kind without a role takes the provider role, and no kinds is the provider role', () => {
    const kind = { id: 'k', label: 'K', functionCap: 'broker' }
    expect(describedRoleOf({ role: 'devices', kinds: [kind] })).toBe('devices')
    expect(describedRoleOf({ role: 'services' })).toBe('services')
    expect(describedRoleOf(null)).toBeUndefined()
  })
})

describe('package manifests', () => {
  it('an entry declaring integration-instances AND a device marker states its integrationRole, never derived', () => {
    const packagesDir = resolve(__dirname, '../../../../../../packages')
    const offenders: string[] = []
    for (const dir of readdirSync(packagesDir)) {
      const file = join(packagesDir, dir, 'package.json')
      if (!existsSync(file)) continue
      const parsed: {
        camstack?: {
          addons?: Array<{
            id: string
            integrationRole?: string
            capabilities?: Array<string | { name: string }>
          }>
        }
      } = JSON.parse(readFileSync(file, 'utf8'))
      for (const entry of parsed.camstack?.addons ?? []) {
        const names = (entry.capabilities ?? []).map((c) => (typeof c === 'string' ? c : c.name))
        const dual =
          names.includes('integration-instances') &&
          names.some((n) => INTEGRATION_CAP_MARKERS.has(n))
        if (dual && entry.integrationRole === undefined) offenders.push(`${dir}:${entry.id}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
