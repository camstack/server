/**
 * The production binding of the migration's record ports: a record already there is never
 * overwritten, whatever the migration offers. Disarm: put without the `exists` check (or without
 * `ifRev: 0`) and "keeps the record the operator already has" fails.
 */
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { haExportTargetsKind, newTargetBody } from '../../target-records.js'
import { defaultLinks, haExportLinksKind } from '../legacy-links-kind.js'
import { haExportMigrationPorts } from '../bind-ports.js'

async function bind() {
  const memory = makeInMemoryRecords('homeassistant-export')
  await memory.records.declare({
    'ha-export-links': haExportLinksKind,
    'ha-export-targets': haExportTargetsKind,
  })
  const links = memory.records.kind(haExportLinksKind)
  const targets = memory.records.kind(haExportTargetsKind)
  const cleared: (readonly string[])[] = []
  const ports = haExportMigrationPorts({
    readStored: async () => ({}),
    api: {
      integrations: {
        list: { query: async () => [] },
        getSettings: { query: async () => ({}) },
        setSettings: { mutate: async () => ({ success: true }) },
      },
    },
    links,
    targets,
    clearSettingKeys: async (keys) => {
      cleared.push(keys)
    },
    warn: () => undefined,
  })
  return { links, targets, ports, cleared }
}

describe('haExportMigrationPorts', () => {
  it('creates a record that is not there', async () => {
    const { links, ports } = await bind()
    expect(await ports.putLinks('ha_001', defaultLinks('ha_001'))).toBe('created')
    expect(await links.get('ha_001')).not.toBeNull()
  })

  it('keeps the record the operator already has', async () => {
    const { links, ports } = await bind()
    await links.put({
      id: 'ha_001',
      data: { ...defaultLinks('Mine'), exportTo: true },
    })
    expect(await ports.putLinks('ha_001', defaultLinks('ha_001'))).toBe('exists')
    expect((await links.get('ha_001'))?.data).toMatchObject({
      name: 'Mine',
      exportTo: true,
    })
    expect((await ports.readLinks()).get('ha_001')?.name).toBe('Mine')
  })

  it('puts a target with ifRev 0 and answers exists for a taken id, never overwriting it', async () => {
    const { targets, ports } = await bind()
    expect(await ports.putTarget('hae_001', newTargetBody('First'))).toBe('created')
    expect(await ports.putTarget('hae_001', newTargetBody('Second'))).toBe('exists')
    expect((await targets.get('hae_001'))?.data.name).toBe('First')
    expect((await ports.readTargets()).get('hae_001')?.name).toBe('First')
  })

  it('deletes the named link rows only, and hands the settings keys to the addon', async () => {
    const { links, ports, cleared } = await bind()
    await links.put({ id: 'ha_001', data: defaultLinks('Home') })
    await links.put({ id: 'ha_002', data: defaultLinks('Cabin') })
    await ports.deleteLinks(['ha_001'])
    expect([...(await ports.readLinks()).keys()]).toEqual(['ha_002'])
    await ports.clearSettingKeys(['knownBrokers'])
    expect(cleared).toEqual([['knownBrokers']])
  })
})
