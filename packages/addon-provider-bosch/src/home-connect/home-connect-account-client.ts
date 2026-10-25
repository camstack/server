import type { HomeConnectGatewayConfig } from './config.js'
import {
  fetchHomeConnectAccount,
  type HomeConnectListedAppliance,
  type LoginFetch,
} from './home-connect-login.js'
import {
  defaultHomeConnectWsClientFactory,
  type HomeConnectApplianceInfo,
  type HomeConnectLinkState,
  type HomeConnectWsClient,
  type HomeConnectWsClientFactory,
} from './home-connect-ws-client.js'

export interface HomeConnectAccountClientOptions {
  readonly token: string
  readonly refresh: string
  readonly fetchImpl?: LoginFetch
  readonly makeGateway?: HomeConnectWsClientFactory
}

/** One account session: the token lists appliances, each appliance has its own local socket. */
export async function openHomeConnectAccount(
  options: HomeConnectAccountClientOptions,
): Promise<HomeConnectWsClient> {
  const account = await fetchHomeConnectAccount(
    { token: options.token, refresh: options.refresh },
    options.fetchImpl,
  )
  return accountClient(account.appliances, options.makeGateway ?? defaultHomeConnectWsClientFactory)
}

export function accountClient(
  appliances: readonly HomeConnectListedAppliance[],
  makeGateway: (config: HomeConnectGatewayConfig) => HomeConnectWsClient,
): HomeConnectWsClient {
  const listed: HomeConnectApplianceInfo[] = appliances.map((app) => ({
    haId: app.haId,
    name: app.name,
    type: app.type,
    availablePrograms: [],
  }))
  const children = new Map<string, HomeConnectWsClient>()
  for (const app of appliances) {
    children.set(app.haId, makeGateway(app.connection))
  }
  const listeners = new Set<(haId: string, key: string, value: unknown) => void>()
  const linkListeners = new Set<(haId: string, state: HomeConnectLinkState) => void>()
  const unsubs: (() => void)[] = []
  for (const [haId, member] of children) {
    unsubs.push(
      member.onFeatureChange((eventHaId, key, value) => {
        const id = eventHaId.length > 0 ? eventHaId : haId
        for (const fn of listeners) fn(id, key, value)
      }),
      member.onLinkChange((eventHaId, state) => {
        const id = eventHaId.length > 0 ? eventHaId : haId
        for (const fn of linkListeners) fn(id, state)
      }),
    )
  }

  function member(haId: string): HomeConnectWsClient {
    const found = children.get(haId)
    if (!found) throw new Error(`Home Connect appliance ${haId} is not on this account`)
    return found
  }

  return {
    async connect(): Promise<void> {
      const results = await Promise.allSettled([...children.values()].map((c) => c.connect()))
      if (results.length > 0 && results.every((result) => result.status === 'rejected')) {
        const first = results[0]
        if (first?.status === 'rejected') throw first.reason
      }
    },
    close(): void {
      for (const unsub of unsubs) unsub()
      for (const c of children.values()) c.close()
    },
    getAppliances: () => listed,
    getFeatures(haId: string): ReadonlyMap<string, unknown> {
      return children.get(haId)?.getFeatures(haId) ?? new Map()
    },
    async setFeature(haId: string, key: string, value: unknown): Promise<void> {
      await member(haId).setFeature(haId, key, value)
    },
    onFeatureChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getLinkState: (haId) => children.get(haId)?.getLinkState(haId) ?? 'disconnected',
    onLinkChange(listener) {
      linkListeners.add(listener)
      return () => linkListeners.delete(listener)
    },
    getDescription: (haId) => children.get(haId)?.getDescription(haId) ?? null,
    async setDescription(haId, description): Promise<void> {
      await member(haId).setDescription(haId, description)
    },
    async selectProgram(haId, program, options): Promise<void> {
      await member(haId).selectProgram(haId, program, options)
    },
    async startProgram(haId, program, options): Promise<void> {
      await member(haId).startProgram(haId, program, options)
    },
  }
}
