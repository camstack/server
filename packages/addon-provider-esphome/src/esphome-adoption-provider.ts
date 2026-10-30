import {
  DeviceType,
  errMsg,
  type AdoptionFilter,
  type AdoptionStatus,
  type DiscoveredChildDevice,
  type IDeviceAdoptionProvider,
  type IScopedLogger,
} from '@camstack/types'
import { deviceTypeOf } from './esphome-child-spec.js'
import { planBoard, type ChildKind, type ChildPlan } from './esphome-entity-spec.js'
import type { EspLink } from './esphome-link.js'
import type { EspBrokerInfo } from './esphome-registry.js'

/** The caps each child kind registers, for the candidate preview. */
const CAPS_OF_KIND: Readonly<Record<ChildKind, readonly string[]>> = {
  switch: ['switch'],
  light: ['switch', 'brightness'],
  cover: ['cover'],
  button: ['button'],
  'number-control': ['control'],
  'select-control': ['control'],
  event: ['event-emitter'],
  'numeric-sensor': ['numeric-sensor'],
  'enum-sensor': ['enum-sensor'],
  contact: ['contact'],
  flood: ['flood'],
  smoke: ['smoke'],
  motion: ['motion'],
  binary: ['binary'],
  'power-meter': ['power-meter'],
}

const BOARD_FILTER: AdoptionFilter = { id: 'devices', label: 'Boards', isDefault: true }

/** Narrow registry surface; the real registry and test fakes both satisfy it. */
export interface EspAdoptionRegistry {
  list(): readonly EspBrokerInfo[]
  get(id: string): EspBrokerInfo | null
  getLink(id: string): EspLink | null
}

interface AdoptedRow {
  readonly id: number
  readonly config: Record<string, unknown>
}

export interface EspAdoptionProviderDeps {
  readonly registry: EspAdoptionRegistry
  /** The boards of one integration, each its own candidate. */
  readonly getBoardIdsForIntegration: (integrationId: string) => Promise<readonly string[]>
  /** Top-level devices of this addon with their persisted config. */
  readonly listAdopted: () => Promise<readonly AdoptedRow[]>
  readonly adoptDevice: (input: {
    readonly brokerId: string
    readonly integrationId: string
    readonly name: string
    readonly boardName: string
  }) => Promise<{ readonly deviceId: number; readonly accessoryDeviceIds: readonly number[] }>
  readonly removeDevice: (camDeviceId: number) => Promise<void>
  readonly findDeviceConfig: (camDeviceId: number) => Promise<Record<string, unknown> | null>
  readonly logger: IScopedLogger
}

function previewChild(plan: ChildPlan): DiscoveredChildDevice {
  return {
    childNativeId: plan.key,
    name: plan.name.length > 0 ? plan.name : plan.key,
    type: deviceTypeOf(plan.kind),
    status: 'online',
    metadata: {},
    alreadyAdopted: false,
    adoptedDeviceId: null,
    capabilities: [...CAPS_OF_KIND[plan.kind]],
  }
}

function adoptedIdOf(rows: readonly AdoptedRow[], brokerId: string): number | null {
  const hit = rows.find(
    (r) => r.config['system'] === 'esphome' && r.config['brokerId'] === brokerId,
  )
  return hit?.id ?? null
}

/**
 * The `device-adoption` provider of the ESPHome addon. One candidate per board
 * (a board IS the container); its entities preview as the container's children.
 * A board that is not connected has no entity list and so no candidate: an
 * unknown board is never shown as an empty one.
 */
export function buildEspAdoptionProvider(deps: EspAdoptionProviderDeps): IDeviceAdoptionProvider {
  const { registry, getBoardIdsForIntegration, listAdopted, adoptDevice, logger } = deps

  async function candidateFor(brokerId: string): Promise<DiscoveredChildDevice | null> {
    const info = registry.get(brokerId)
    const link = registry.getLink(brokerId)
    if (info === null || link === null) return null
    const board = link.info()
    const adoptedId = adoptedIdOf(await listAdopted(), brokerId)
    return {
      childNativeId: brokerId,
      name: board.name.length > 0 ? board.name : info.name,
      type: DeviceType.Container,
      status: 'online',
      metadata: {
        model: board.model,
        manufacturer: 'ESPHome',
      },
      alreadyAdopted: adoptedId !== null,
      adoptedDeviceId: adoptedId,
      capabilities: [],
      children: planBoard(link.entities()).map(previewChild),
    }
  }

  async function statusFor(brokerIds: readonly string[]): Promise<AdoptionStatus> {
    try {
      const rows = await listAdopted()
      let candidateCount = 0
      for (const id of brokerIds) if (registry.getLink(id) !== null) candidateCount += 1
      const adoptedCount = rows.filter(
        (r) =>
          r.config['system'] === 'esphome' &&
          typeof r.config['brokerId'] === 'string' &&
          brokerIds.includes(r.config['brokerId']),
      ).length
      return { lastDiscoveryAt: Date.now(), candidateCount, adoptedCount, lastError: null }
    } catch (err: unknown) {
      logger.warn('esphome adoption: status failed', { meta: { error: errMsg(err) } })
      return { lastDiscoveryAt: null, candidateCount: 0, adoptedCount: 0, lastError: errMsg(err) }
    }
  }

  return {
    listCandidateFilters: async () => ({ filters: [BOARD_FILTER] }),

    listCandidates: async ({ integrationId, page, pageSize, filterText }) => {
      const boardIds = await getBoardIdsForIntegration(integrationId)
      const needle = filterText?.search?.trim().toLowerCase() ?? ''
      const all: DiscoveredChildDevice[] = []
      for (const boardId of boardIds) {
        const one = await candidateFor(boardId)
        if (one !== null && one.name.toLowerCase().includes(needle)) all.push(one)
      }
      const start = (page - 1) * pageSize
      return {
        candidates: all.slice(start, start + pageSize),
        totalCount: all.length,
        page,
        pageSize,
      }
    },

    getCandidate: async ({ integrationId, childNativeId }) => {
      const boardIds = await getBoardIdsForIntegration(integrationId)
      return boardIds.includes(childNativeId) ? candidateFor(childNativeId) : null
    },

    getStatus: async () => statusFor(registry.list().map((b) => b.id)),

    refresh: async ({ integrationId }) => statusFor(await getBoardIdsForIntegration(integrationId)),

    adopt: async ({ integrationId, childNativeIds, perCandidate }) => {
      const boardIds = await getBoardIdsForIntegration(integrationId)
      const adopted: {
        readonly childNativeId: string
        readonly parentDeviceId: number
        readonly accessoryDeviceIds: readonly number[]
      }[] = []
      let failures = 0
      for (const childNativeId of childNativeIds) {
        const link = boardIds.includes(childNativeId) ? registry.getLink(childNativeId) : null
        if (link === null) {
          failures += 1
          logger.warn('esphome adopt: board is not connected or not in this integration', {
            meta: { integrationId, boardId: childNativeId },
          })
          continue
        }
        try {
          const boardName = link.info().name
          const name = perCandidate?.[childNativeId]?.name ?? boardName
          const { deviceId, accessoryDeviceIds } = await adoptDevice({
            brokerId: childNativeId,
            integrationId,
            name: name.length > 0 ? name : childNativeId,
            boardName,
          })
          adopted.push({ childNativeId, parentDeviceId: deviceId, accessoryDeviceIds })
        } catch (err: unknown) {
          failures += 1
          logger.warn('esphome adopt: failed to adopt board', {
            meta: { boardId: childNativeId, error: errMsg(err) },
          })
        }
      }
      if (adopted.length === 0 && failures > 0) {
        throw new Error(`esphome adopt: all ${failures} adopt(s) failed`)
      }
      return { adopted }
    },

    release: async ({ camDeviceId }) => {
      await deps.removeDevice(camDeviceId)
    },

    resync: async ({ camDeviceId }) => {
      const cfg = await deps.findDeviceConfig(camDeviceId)
      if (cfg === null) throw new Error(`esphome resync: device ${camDeviceId} not found`)
      if (cfg['system'] !== 'esphome') {
        throw new Error(`esphome resync: device ${camDeviceId} is not an ESPHome board`)
      }
      const brokerId = String(cfg['brokerId'])
      if (registry.getLink(brokerId) === null) {
        throw new Error(`esphome resync: board ${brokerId} is not connected`)
      }
      // The container derives its children from the live entity list on every
      // probe, so there is nothing structural to rebuild here.
      return { changed: false, rebuiltChildren: 0 }
    },
  }
}
