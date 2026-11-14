/**
 * The cameras that name no integration are claimed to the addon's default one (D1007). The
 * integration a hub migration created is never the default, even when its id sorts first.
 */
import {
  defineAddonMigrations,
  type ClaimDevicesPorts,
  type MigrationOwnerResult,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { MIGRATED_FROM_HUB_KEY } from '../hub-connection.js'
import { CLAIM_DEVICES_DATE, REOLINK_CLAIM_MIGRATION } from '../migrations/index.js'

function world(devices: { id: number; integrationId?: string }[]) {
  const stored = new Map(devices.map((d) => [d.id, d.integrationId ?? null]))
  const ports: ClaimDevicesPorts = {
    listIntegrations: async () => [
      // Sorts first and was created by a hub migration: it must not be the default.
      { id: 'int_0005', name: 'Hub', info: { [MIGRATED_FROM_HUB_KEY]: 7 } },
      { id: 'int_0012', name: 'Reolink', info: {} },
    ],
    listDevices: async () => [...stored].map(([id, integrationId]) => ({ id, integrationId })),
    setIntegrationId: async (id, integrationId) => {
      stored.set(id, integrationId)
    },
    readIntegrationId: async (id) => stored.get(id) ?? null,
    hasConfig: async () => true,
    info: () => undefined,
    warnDevice: () => undefined,
  }
  return { stored, ports }
}

async function run(ports: ClaimDevicesPorts): Promise<MigrationOwnerResult> {
  const [bound] = defineAddonMigrations([REOLINK_CLAIM_MIGRATION], ports)
  if (bound === undefined) throw new Error('no migration bound')
  return bound.execute()
}

describe('reolink device claim', () => {
  it('is declared under the addon id and tolerates failure', () => {
    expect(REOLINK_CLAIM_MIGRATION.meta.id).toBe(
      `provider-reolink/${CLAIM_DEVICES_DATE}-claim-devices-to-default-integration`,
    )
    expect(REOLINK_CLAIM_MIGRATION.meta.onFailure).toBe('tolerate')
  })

  it('claims unstamped cameras to the default, never to the migrated hub, and leaves stamped ones', async () => {
    const { stored, ports } = world([{ id: 1 }, { id: 2 }, { id: 3, integrationId: 'int_0005' }])
    const result = await run(ports)
    expect(result.kind).toBe('procedure')
    expect(stored.get(1)).toBe('int_0012')
    expect(stored.get(2)).toBe('int_0012')
    expect(stored.get(3)).toBe('int_0005')
    const again = await run(ports)
    expect(JSON.stringify(again)).toContain('already-done')
  })
})
