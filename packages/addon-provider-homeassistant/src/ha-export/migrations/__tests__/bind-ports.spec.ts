/**
 * The production binding of the migration's record ports: a record already there is never
 * overwritten, whatever the migration offers. Disarm: put without the `exists` check (or without
 * `ifRev: 0`) and "keeps the record the operator already has" fails.
 */
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { defaultLinks, haExportLinksKind } from '../../link-records.js'
import { haExportMigrationPorts } from '../bind-ports.js'

async function bind() {
  const memory = makeInMemoryRecords('homeassistant-export')
  await memory.records.declare({ 'ha-export-links': haExportLinksKind })
  const links = memory.records.kind(haExportLinksKind)
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
    warn: () => undefined,
  })
  return { links, ports }
}

describe('haExportMigrationPorts', () => {
  it('creates a record that is not there', async () => {
    const { links, ports } = await bind()
    expect(await ports.putLinks('ha_001', defaultLinks('ha_001'))).toBe('created')
    expect(await links.get('ha_001')).not.toBeNull()
  })

  it('keeps the record the operator already has', async () => {
    const { links, ports } = await bind()
    await links.put({ id: 'ha_001', data: { ...defaultLinks('Mine'), exportTo: true } })
    expect(await ports.putLinks('ha_001', defaultLinks('ha_001'))).toBe('exists')
    expect((await links.get('ha_001'))?.data).toMatchObject({ name: 'Mine', exportTo: true })
    expect((await ports.readLinks()).get('ha_001')?.name).toBe('Mine')
  })
})
