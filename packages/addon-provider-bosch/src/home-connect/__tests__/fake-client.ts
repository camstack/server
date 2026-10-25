import { HomeConnectDescriptionStore } from '../home-connect-description-store.js'
import type {
  HomeConnectApplianceInfo,
  HomeConnectLinkState,
  HomeConnectWsClient,
} from '../home-connect-ws-client.js'

/** A scriptable client handle: drive features and link state the way the real client reports them. */
export interface FakeHomeConnectClient extends HomeConnectWsClient {
  readonly setFeatureCalls: { haId: string; key: string; value: unknown }[]
  readonly selectCalls: { haId: string; program: string; options: unknown }[]
  readonly startCalls: { haId: string; program: string; options: unknown }[]
  emitFeature(haId: string, key: string, value: unknown): void
  emitLink(haId: string, state: HomeConnectLinkState): void
  readonly description: HomeConnectDescriptionStore
}

export interface FakeClientInput {
  readonly appliances?: readonly HomeConnectApplianceInfo[]
  readonly features?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly description?: string | Record<string, unknown>
  readonly link?: HomeConnectLinkState
  readonly connect?: () => Promise<void>
  readonly setFeature?: (haId: string, key: string, value: unknown) => Promise<void>
}

/** A complete {@link HomeConnectWsClient} with no socket behind it. */
export function makeFakeClient(input: FakeClientInput = {}): FakeHomeConnectClient {
  const appliances = [...(input.appliances ?? [])]
  const stores = new Map<string, Map<string, unknown>>()
  for (const [haId, rows] of Object.entries(input.features ?? {})) {
    stores.set(haId, new Map(Object.entries(rows)))
  }
  const featureListeners = new Set<(haId: string, key: string, value: unknown) => void>()
  const linkListeners = new Set<(haId: string, state: HomeConnectLinkState) => void>()
  const description = new HomeConnectDescriptionStore(input.description)
  const links = new Map<string, HomeConnectLinkState>()
  const calls: { haId: string; key: string; value: unknown }[] = []
  const selectCalls: { haId: string; program: string; options: unknown }[] = []
  const startCalls: { haId: string; program: string; options: unknown }[] = []

  function featuresOf(haId: string): Map<string, unknown> {
    let map = stores.get(haId)
    if (!map) {
      map = new Map()
      stores.set(haId, map)
    }
    return map
  }

  return {
    setFeatureCalls: calls,
    selectCalls,
    startCalls,
    description,
    connect: input.connect ?? (async () => undefined),
    close: () => undefined,
    getAppliances: () => appliances,
    getFeatures: (haId) => featuresOf(haId),
    async setFeature(haId, key, value) {
      calls.push({ haId, key, value })
      await input.setFeature?.(haId, key, value)
    },
    onFeatureChange(listener) {
      featureListeners.add(listener)
      return () => featureListeners.delete(listener)
    },
    getLinkState: (haId) => links.get(haId) ?? input.link ?? 'connected',
    onLinkChange(listener) {
      linkListeners.add(listener)
      return () => linkListeners.delete(listener)
    },
    getDescription: () => description,
    setDescription: async (_haId, next) => description.replace(next),
    selectProgram: async (haId, program, options) => {
      selectCalls.push({ haId, program, options })
    },
    startProgram: async (haId, program, options) => {
      startCalls.push({ haId, program, options })
    },
    emitFeature(haId, key, value) {
      featuresOf(haId).set(key, value)
      for (const fn of featureListeners) fn(haId, key, value)
    },
    emitLink(haId, state) {
      links.set(haId, state)
      if (state !== 'connected') featuresOf(haId).clear()
      for (const fn of linkListeners) fn(haId, state)
    },
  }
}
