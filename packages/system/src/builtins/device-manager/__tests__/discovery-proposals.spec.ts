import {
  createRecordsAccess,
  DeviceType,
  type DiscoveryMode,
  type DiscoveryObservation,
  type IScopedLogger,
  type LogExtras,
  type RecordsAccess,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeRecordsWorld } from '../../sqlite-storage/__tests__/support/records-world.js'
import type { DiscoveryProvider } from '../discovery-orchestrator.js'
import { DiscoveryProposalService, hitsForObservation } from '../discovery-proposal-service.js'
import { DiscoveryProposalStore, type ProposalOwnership } from '../discovery-proposal-store.js'
import { deviceManagerRecordKinds } from '../record-kinds.js'

class QuietLogger implements IScopedLogger {
  info = vi.fn<(message: string, extras?: LogExtras) => void>()
  warn = vi.fn<(message: string, extras?: LogExtras) => void>()
  debug(): void {}
  error(): void {}
  child(): IScopedLogger {
    return this
  }
  withTags(): IScopedLogger {
    return this
  }
}

function candidate(stableId: string) {
  return { stableId, type: DeviceType.Container, suggestedName: stableId, prefilledConfig: {} }
}

const mdnsMode: DiscoveryMode = { kind: 'mdns', serviceType: '_esphomelib._tcp' }

const sighting: DiscoveryObservation = {
  kind: 'mdns',
  serviceType: '_esphomelib._tcp',
  instance: 'kitchen',
  host: 'kitchen.local',
  address: '192.0.2.10',
  port: 6053,
  txt: {},
}

function provider(): DiscoveryProvider {
  return {
    getDiscoveryModes: async () => [mdnsMode],
    classifyDiscoveryHits: async ({ hits }) => hits.map((h) => candidate(`esp-${h.host}`)),
    discoverDevices: async () => [candidate('swept-device')],
  }
}

const nothingOwned: ProposalOwnership = {
  deviceStableIds: new Set(),
  integrationOriginIds: new Set(),
}

async function openWorld() {
  const world = makeRecordsWorld()
  await world.provider.init()
  const open = async (): Promise<RecordsAccess> => {
    const records = createRecordsAccess({
      owner: 'device-manager',
      transport: world.transportFor('device-manager'),
      secrets: null,
    })
    await records.declare(deviceManagerRecordKinds)
    return records
  }
  return { open }
}

function service(
  store: DiscoveryProposalStore,
  owned: () => Promise<ProposalOwnership>,
  served: DiscoveryProvider = provider(),
) {
  const logger = new QuietLogger()
  return new DiscoveryProposalService({
    store,
    orchestrator: {
      requireProvider: async () => served,
      scanNetwork: async () => ({
        hits: [],
        subnetsScanned: [],
        errors: [],
        stats: { hostsProbed: 0, hits: 0, timeouts: 0, byMode: {} },
      }),
      originStableIds: async () => new Set(),
      logger,
    },
    providerIds: async () => ['provider-esphome'],
    requireProvider: async () => served,
    ownership: owned,
    logger,
  })
}

describe('discovery proposals', () => {
  it('a proposal persists and survives a restart on the real store', async () => {
    const { open } = await openWorld()
    const first = DiscoveryProposalStore.of(await open(), () => 1_000)
    await first.observe('provider-esphome', [candidate('esp-1')])

    // A restart: a brand new access and store over the same database.
    const afterRestart = DiscoveryProposalStore.of(await open(), () => 2_000)
    const list = await afterRestart.listVisible(nothingOwned)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      addonId: 'provider-esphome',
      firstSeenAt: 1_000,
      lastSeenAt: 1_000,
      dismissed: false,
    })
  })

  it('re-seeing keeps the first-seen time and moves the last-seen time', async () => {
    const { open } = await openWorld()
    let now = 1_000
    const store = DiscoveryProposalStore.of(await open(), () => now)
    expect(await store.observe('provider-esphome', [candidate('esp-1')])).toBe(1)
    now = 5_000
    expect(await store.observe('provider-esphome', [candidate('esp-1')])).toBe(0)
    const [only] = await store.listVisible(nothingOwned)
    expect(only).toMatchObject({ firstSeenAt: 1_000, lastSeenAt: 5_000 })
  })

  it('a dismissed proposal stays dismissed when the device is seen again', async () => {
    const { open } = await openWorld()
    const store = DiscoveryProposalStore.of(await open())
    await store.observe('provider-esphome', [candidate('esp-1')])
    const [shown] = await store.listVisible(nothingOwned)
    expect(shown).toBeDefined()
    expect(await store.dismiss(shown?.id ?? '')).toBe(true)

    await store.observe('provider-esphome', [candidate('esp-1')])
    expect(await store.listVisible(nothingOwned)).toHaveLength(0)

    // ...and it is still dismissed after a restart.
    const reopened = DiscoveryProposalStore.of(await open())
    await reopened.observe('provider-esphome', [candidate('esp-1')])
    expect(await reopened.listVisible(nothingOwned)).toHaveLength(0)
  })

  it('an adopted device, or an integration we own, is not shown', async () => {
    const { open } = await openWorld()
    const store = DiscoveryProposalStore.of(await open())
    await store.observe('provider-esphome', [
      candidate('adopted'),
      candidate('integration'),
      candidate('fresh'),
    ])
    const visible = await store.listVisible({
      deviceStableIds: new Set(['adopted']),
      integrationOriginIds: new Set(['integration']),
    })
    expect(visible.map((p) => p.candidate.stableId)).toEqual(['fresh'])
  })

  it('a candidate the provider says it already owns is never proposed', async () => {
    const { open } = await openWorld()
    const store = DiscoveryProposalStore.of(await open())
    const created = await store.observe('provider-esphome', [
      { ...candidate('owned'), alreadyOnboarded: true },
    ])
    expect(created).toBe(0)
    expect(await store.listVisible(nothingOwned)).toHaveLength(0)
  })

  it('a passive sighting reaches the provider whose declared mode matches, and no other', async () => {
    const { open } = await openWorld()
    const store = DiscoveryProposalStore.of(await open())
    const svc = service(store, async () => nothingOwned)
    expect(await svc.reportObservations([sighting])).toEqual({ proposed: 1 })
    expect((await svc.list()).map((p) => p.candidate.stableId)).toEqual(['esp-192.0.2.10'])

    const other: DiscoveryObservation = { ...sighting, serviceType: '_hap._tcp' }
    expect(await svc.reportObservations([other])).toEqual({ proposed: 0 })
  })

  it('a sweep records the providers candidates as proposals', async () => {
    const { open } = await openWorld()
    const legacy: DiscoveryProvider = { ...provider(), getDiscoveryModes: async () => [] }
    const svc = service(DiscoveryProposalStore.of(await open()), async () => nothingOwned, legacy)
    expect(await svc.runSweep()).toEqual({ providers: 1, proposed: 1 })
    expect((await svc.list()).map((p) => p.candidate.stableId)).toEqual(['swept-device'])
  })

  it('hitsForObservation honours the instance pattern', () => {
    const modes: DiscoveryMode[] = [{ ...mdnsMode, instancePattern: '^bedroom' }]
    expect(hitsForObservation(modes, sighting)).toHaveLength(0)
    expect(hitsForObservation(modes, { ...sighting, instance: 'Bedroom-2' })).toHaveLength(1)
  })
})
