/**
 * Matter is a connection-holding device provider (D985, D996): the manifest and the instances
 * provider must say the same thing about how many integrations it allows. The backend prefers the
 * provider's answer, but the manifest is what shows when the provider is not up yet.
 */
import { readFileSync } from 'node:fs'
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { matterConnectionsEntryKind } from '../broker-record-kinds.js'
import { buildMatterInstances } from '../matter-instances.js'

interface Manifest {
  readonly camstack: { readonly addons: readonly { readonly instanceMode?: string }[] }
}

describe('matter instance mode', () => {
  it('the manifest declares the mode the instances provider describes', async () => {
    const manifest: Manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    )
    const world = makeInMemoryRecords('matter-broker')
    await world.records.declare({ connections: matterConnectionsEntryKind })
    const instances = buildMatterInstances(world.records)

    const described = await instances.describe()

    expect(manifest.camstack.addons[0]?.instanceMode).toBe(described.instanceMode)
  })
})
