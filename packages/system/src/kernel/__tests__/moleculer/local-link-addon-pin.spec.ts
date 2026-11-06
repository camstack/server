import { describe, expect, it } from 'vitest'
import { createTRPCClient, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import { localProviderLink, type LocalProviderResolver } from '../../moleculer/trpc-links.js'

interface ListInstancesProcedure {
  query: (input: { addonId?: string }) => Promise<unknown>
}
interface CollectionClient {
  integrationInstances: { listInstances: ListInstancesProcedure }
  addons: { getLogs: ListInstancesProcedure }
}

const OWN_ADDON = 'homeassistant-export'
const OTHER_ADDON = 'provider-homeassistant'

const own = { listInstances: async () => ['own-record'], getLogs: async () => ['own-logs'] }

/** A runner that co-hosts its OWN provider of the collection cap. */
const resolver: LocalProviderResolver = {
  localNodeId: 'hub/integrations',
  getByName: (name) => (name === 'integration-instances' || name === 'addons' ? own : null),
  getByAddonId: (name, addonId) =>
    name === 'integration-instances' && addonId === OWN_ADDON ? own : null,
}

/** Terminating link standing in for the parent route. */
const routed: TRPCLink<never> = () => () =>
  observable((observer) => {
    observer.next({ result: { type: 'data', data: ['routed'] } })
    observer.complete()
    return () => {}
  })

function client(): CollectionClient {
  const made: unknown = createTRPCClient<never>({ links: [localProviderLink(resolver), routed] })
  return made as CollectionClient
}

describe('localProviderLink — the addon pin of a collection cap', () => {
  it('routes out a call pinned to ANOTHER addon, never answers with the co-hosted provider', async () => {
    expect(
      await client().integrationInstances.listInstances.query({ addonId: OTHER_ADDON }),
    ).toEqual(['routed'])
  })

  it('answers locally when the pinned addon IS the local one', async () => {
    expect(await client().integrationInstances.listInstances.query({ addonId: OWN_ADDON })).toEqual(
      ['own-record'],
    )
  })

  it('keeps local-first for an unpinned call', async () => {
    expect(await client().integrationInstances.listInstances.query({})).toEqual(['own-record'])
  })

  it('leaves addonId as plain data on a non-collection cap', async () => {
    expect(await client().addons.getLogs.query({ addonId: OTHER_ADDON })).toEqual(['own-logs'])
  })
})
