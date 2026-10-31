import {
  type AdoptionFilter,
  type AdoptionStatus,
  type DiscoveredChildDevice,
  errMsg,
  type IDeviceAdoptionProvider,
  type IScopedLogger,
} from '@camstack/types'
import type { ReolinkHubConnection } from './hub-connection.js'
import {
  type HubChannel,
  type HubChannelSnapshot,
  hubGatewayNativeId,
  toDiscoveredChild,
  toDiscoveredGateway,
} from './reolink-hub-session.js'

/** What the adoption surface needs of one integration's NVR / Home Hub session. */
export interface AdoptionSession {
  readonly connection: ReolinkHubConnection
  /** The integration's display name: the hub's own name in the list. */
  readonly name: string
  /** The hub socket is up. */
  readonly isOnline: boolean
  channelSnapshot(): HubChannelSnapshot
  /** Re-read the hub's channel list now. */
  refresh(): Promise<void>
}

/** A camera this addon already owns, as the adoption surface needs to see it. */
export interface AdoptedReolinkCamera {
  readonly id: number
  readonly config: Readonly<Record<string, unknown>>
}

export interface ReolinkAdoptionProviderDeps {
  readonly getSession: (integrationId: string) => AdoptionSession | null
  /** Integrations that have a live session. */
  readonly listIntegrations: () => readonly string[]
  readonly listAdopted: () => Promise<readonly AdoptedReolinkCamera[]>
  /** Create a top-level camera for `channel`, stamped with `integrationId`. */
  readonly adoptCamera: (input: {
    readonly integrationId: string
    readonly channel: HubChannel
    readonly connection: ReolinkHubConnection
    readonly name: string
  }) => Promise<{
    readonly deviceId: number
    readonly accessoryDeviceIds: readonly number[]
  }>
  /** The hub (Gateway) devices this addon already owns. */
  readonly listAdoptedGateways: () => Promise<
    readonly { readonly id: number; readonly integrationId: string }[]
  >
  /** Create the top-level Gateway device of `integrationId`. */
  readonly adoptGateway: (input: {
    readonly integrationId: string
    readonly name: string
  }) => Promise<{ readonly deviceId: number }>
  readonly removeDevice: (deviceId: number) => Promise<void>
  readonly findDeviceConfig: (deviceId: number) => Promise<Record<string, unknown> | null>
  readonly logger: IScopedLogger
}

const DEVICES_FILTER: AdoptionFilter = {
  id: 'devices',
  label: 'Cameras',
  isDefault: true,
}

/**
 * The deviceId of the camera that already represents `channel` on `integrationId`, or null.
 * Matched by the camera's own identity (uid) first and its channel second, so a camera migrated
 * from an old Hub — whose stableId carries the old hub's prefix — is still recognised.
 */
export function findAdoptedForChannel(
  adopted: readonly AdoptedReolinkCamera[],
  integrationId: string,
  channel: HubChannel,
): number | null {
  for (const camera of adopted) {
    if (camera.config['integrationId'] !== integrationId) continue
    const uid = camera.config['uid']
    if (channel.uid !== undefined && typeof uid === 'string' && uid === channel.uid)
      return camera.id
  }
  for (const camera of adopted) {
    if (camera.config['integrationId'] !== integrationId) continue
    if (camera.config['channel'] === channel.channel) return camera.id
  }
  return null
}

export function buildReolinkAdoptionProvider(
  deps: ReolinkAdoptionProviderDeps,
): IDeviceAdoptionProvider {
  const { getSession, listIntegrations, listAdopted, logger } = deps

  async function candidates(integrationId: string): Promise<readonly DiscoveredChildDevice[]> {
    const session = getSession(integrationId)
    if (session === null) return []
    const adopted = await listAdopted()
    const gateways = await deps.listAdoptedGateways()
    const gateway = toDiscoveredGateway({
      integrationId,
      name: session.name,
      online: session.isOnline,
      adoptedDeviceId: gateways.find((g) => g.integrationId === integrationId)?.id ?? null,
    })
    // The hub is a sibling of its channel cameras, listed first and never their parent.
    return [
      gateway,
      ...session
        .channelSnapshot()
        .channels.map((channel) =>
          toDiscoveredChild(channel, findAdoptedForChannel(adopted, integrationId, channel)),
        ),
    ]
  }

  async function status(integrationId: string): Promise<AdoptionStatus> {
    const all = await candidates(integrationId)
    return {
      lastDiscoveryAt: getSession(integrationId)?.channelSnapshot().lastRefreshAt ?? null,
      candidateCount: all.length,
      adoptedCount: all.filter((c) => c.alreadyAdopted).length,
      lastError: getSession(integrationId)?.channelSnapshot().lastError ?? null,
    }
  }

  return {
    listCandidateFilters: async () => ({ filters: [DEVICES_FILTER] }),

    listCandidates: async ({ integrationId, page, pageSize }) => {
      const all = await candidates(integrationId)
      const start = (page - 1) * pageSize
      return {
        candidates: all.slice(start, start + pageSize),
        totalCount: all.length,
        page,
        pageSize,
      }
    },

    getCandidate: async ({ integrationId, childNativeId }) => {
      const all = await candidates(integrationId)
      return all.find((c) => c.childNativeId === childNativeId) ?? null
    },

    getStatus: async () => {
      try {
        let candidateCount = 0
        let adoptedCount = 0
        for (const integrationId of listIntegrations()) {
          const s = await status(integrationId)
          candidateCount += s.candidateCount
          adoptedCount += s.adoptedCount
        }
        return {
          lastDiscoveryAt: Date.now(),
          candidateCount,
          adoptedCount,
          lastError: null,
        }
      } catch (err: unknown) {
        return {
          lastDiscoveryAt: null,
          candidateCount: 0,
          adoptedCount: 0,
          lastError: errMsg(err),
        }
      }
    },

    refresh: async ({ integrationId }) => {
      await getSession(integrationId)?.refresh()
      return status(integrationId)
    },

    adopt: async ({ integrationId, childNativeIds, perCandidate }) => {
      const session = getSession(integrationId)
      if (session === null) {
        throw new Error(`reolink adopt: integration ${integrationId} has no live NVR session`)
      }
      if (session.channelSnapshot().channels.length === 0) await session.refresh()
      const adopted: Array<{
        readonly childNativeId: string
        readonly parentDeviceId: number
        readonly accessoryDeviceIds: readonly number[]
      }> = []
      let failures = 0
      for (const childNativeId of childNativeIds) {
        try {
          if (childNativeId === hubGatewayNativeId(integrationId)) {
            const known = (await deps.listAdoptedGateways()).find(
              (g) => g.integrationId === integrationId,
            )
            const { deviceId } =
              known !== undefined
                ? { deviceId: known.id }
                : await deps.adoptGateway({
                    integrationId,
                    name: perCandidate?.[childNativeId]?.name ?? session.name,
                  })
            adopted.push({ childNativeId, parentDeviceId: deviceId, accessoryDeviceIds: [] })
            continue
          }
          const channel = session
            .channelSnapshot()
            .channels.find((c) => c.childNativeId === childNativeId)
          if (channel === undefined) {
            logger.warn('reolink adopt: the hub lists no such channel — skipping', {
              meta: { childNativeId, integrationId },
            })
            failures++
            continue
          }
          const existing = findAdoptedForChannel(await listAdopted(), integrationId, channel)
          if (existing !== null) {
            adopted.push({
              childNativeId,
              parentDeviceId: existing,
              accessoryDeviceIds: [],
            })
            continue
          }
          const { deviceId, accessoryDeviceIds } = await deps.adoptCamera({
            integrationId,
            channel,
            connection: session.connection,
            name: perCandidate?.[childNativeId]?.name ?? channel.name,
          })
          adopted.push({
            childNativeId,
            parentDeviceId: deviceId,
            accessoryDeviceIds,
          })
        } catch (err: unknown) {
          logger.warn('reolink adopt: failed to adopt channel', {
            meta: { childNativeId, integrationId, error: errMsg(err) },
          })
          failures++
        }
      }
      if (adopted.length === 0 && failures > 0) {
        throw new Error(`reolink adopt: all ${failures} adopt(s) failed`)
      }
      await session.refresh().catch(() => undefined)
      return { adopted }
    },

    release: async ({ camDeviceId }) => {
      await deps.removeDevice(camDeviceId)
    },

    resync: async ({ camDeviceId }) => {
      const cfg = await deps.findDeviceConfig(camDeviceId)
      if (cfg === null || typeof cfg['integrationId'] !== 'string') {
        throw new Error(`reolink resync: device ${camDeviceId} is not an NVR-adopted device`)
      }
      return { changed: false, rebuiltChildren: 0 }
    },
  }
}
