/**
 * Additive endpoint reconcile for adopted Matter nodes, split from the addon so
 * it is testable: reduce a node snapshot to its mappable endpoints, persist a
 * changed set, and say once per change what the snapshot held.
 */

import { z } from 'zod'
import { errMsg, type IScopedLogger } from '@dominevo/types'
import type { MatterNodeSnapshot } from './matter-controller.js'
import { MatterClusterId, mapMatterEndpointToCamStack } from './matter-cluster-mapping.js'
import {
  matterEndpointEntrySchema,
  type MatterEndpointEntry,
} from './devices/matter-node-device.js'

/** What the battery-endpoint fold decided for a node, for the reconcile's log line. */
export type FoldDecision =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'folded'
      readonly powerSourceEndpointId: number
      readonly intoEndpointId: number
    }
  | {
      readonly kind: 'kept-separate'
      readonly reason: 'several-functional-endpoints' | 'several-battery-endpoints'
      readonly functionalEndpoints: number
      readonly batteryEndpoints: number
    }

export interface EndpointPlan {
  readonly entries: MatterEndpointEntry[]
  readonly fold: FoldDecision
}

/** Reduce a node snapshot to its mappable endpoint entries (skip cap-less ones). */
export function mappableEndpoints(node: MatterNodeSnapshot): MatterEndpointEntry[] {
  return planEndpoints(node).entries
}

/** The mappable entries plus what the PowerSource fold decided. */
export function planEndpoints(node: MatterNodeSnapshot): EndpointPlan {
  const out: MatterEndpointEntry[] = []
  const batteryOnly: number[] = []
  for (const endpoint of node.endpoints) {
    const mapping = mapMatterEndpointToCamStack(endpoint.clusterIds, {
      deviceTypeIds: endpoint.deviceTypeIds ?? [],
      attributes: endpoint.attributes ?? [],
    })
    if (mapping.capabilities.length === 0) continue
    const isBatteryOnly = mapping.capabilities.every((cap) => cap === 'battery')
    if (isBatteryOnly) batteryOnly.push(out.length)
    out.push({
      endpointId: endpoint.endpointId,
      clusterIds: [...endpoint.clusterIds],
      deviceTypeIds: [...(endpoint.deviceTypeIds ?? [])],
      attributes: [...(endpoint.attributes ?? [])],
      ...(endpoint.lockUnbolting !== undefined ? { lockUnbolting: endpoint.lockUnbolting } : {}),
    })
  }
  return foldPowerSource(out, batteryOnly)
}

/**
 * A PowerSource-only endpoint is the battery of the node's functional endpoint,
 * not a device — but only when that is unambiguous: exactly one functional
 * endpoint and exactly one battery-only endpoint. Otherwise every endpoint stays
 * its own child. The orphaned child of an install adopted before the fold is
 * retired by the kernel's shrink gate (D49): MatterNodeDevice answers a COMPLETE read once the persisted list agrees with the live snapshot, and the child is pruned after a second agreeing read on a later probe, never here.
 */
function foldPowerSource(
  entries: MatterEndpointEntry[],
  batteryOnlyIndexes: readonly number[],
): EndpointPlan {
  const batteryEndpoints = batteryOnlyIndexes.length
  if (batteryEndpoints === 0) return { entries, fold: { kind: 'none' } }
  const functionalIndexes = entries.flatMap((_, i) => (batteryOnlyIndexes.includes(i) ? [] : [i]))
  const sourceIndex = batteryOnlyIndexes[0]
  const targetIndex = functionalIndexes[0]
  const source = sourceIndex === undefined ? undefined : entries[sourceIndex]
  if (batteryEndpoints > 1 || functionalIndexes.length > 1) {
    return {
      entries,
      fold: {
        kind: 'kept-separate',
        reason: batteryEndpoints > 1 ? 'several-battery-endpoints' : 'several-functional-endpoints',
        functionalEndpoints: functionalIndexes.length,
        batteryEndpoints,
      },
    }
  }
  const target = targetIndex === undefined ? undefined : entries[targetIndex]
  if (
    source === undefined ||
    target === undefined ||
    target.clusterIds.includes(MatterClusterId.PowerSource)
  ) {
    return { entries, fold: { kind: 'none' } }
  }
  return {
    entries: entries.flatMap((entry, i) => {
      if (i === sourceIndex) return []
      if (i === targetIndex) return [{ ...entry, powerSourceEndpointId: source.endpointId }]
      return [entry]
    }),
    fold: {
      kind: 'folded',
      powerSourceEndpointId: source.endpointId,
      intoEndpointId: target.endpointId,
    },
  }
}

/**
 * Structural equality of two persisted endpoint lists. An entry persisted before
 * the Descriptor device types / attribute keys were read differs from the live
 * one, so the node re-derives its children.
 */
export function endpointsEqual(a: readonly unknown[], b: readonly MatterEndpointEntry[]): boolean {
  const parsed = z.array(matterEndpointEntrySchema).safeParse(a)
  if (!parsed.success || parsed.data.length !== b.length) return false
  const key = (e: MatterEndpointEntry): string =>
    JSON.stringify([
      e.endpointId,
      [...e.clusterIds].sort((x, y) => x - y),
      [...e.deviceTypeIds].sort((x, y) => x - y),
      [...e.attributes].sort(),
      e.lockUnbolting ?? null,
      e.powerSourceEndpointId ?? null,
    ])
  const current = new Set(parsed.data.map(key))
  return b.every((entry) => current.has(key(entry)))
}

interface EndpointInventoryLine {
  readonly endpointId: number
  readonly deviceTypeIds: readonly number[]
  readonly clusterIds: readonly number[]
  readonly capabilities: readonly string[]
}

function inventoryOf(node: MatterNodeSnapshot): EndpointInventoryLine[] {
  return node.endpoints.map((endpoint) => ({
    endpointId: endpoint.endpointId,
    deviceTypeIds: endpoint.deviceTypeIds ?? [],
    clusterIds: endpoint.clusterIds,
    capabilities: mapMatterEndpointToCamStack(endpoint.clusterIds, {
      deviceTypeIds: endpoint.deviceTypeIds ?? [],
      attributes: endpoint.attributes ?? [],
    }).capabilities,
  }))
}

/** Logs a node's endpoint inventory once per change, never per tick. */
export class NodeEndpointReporter {
  readonly #last = new Map<string, string>()
  readonly #logger: IScopedLogger

  constructor(logger: IScopedLogger) {
    this.#logger = logger
  }

  report(brokerId: string, node: MatterNodeSnapshot, deviceId: number | null): void {
    const inventory = inventoryOf(node)
    const key = `${brokerId}:${node.nodeId}`
    const serialised = JSON.stringify(inventory)
    if (this.#last.get(key) === serialised) return
    this.#last.set(key, serialised)
    for (const endpoint of node.endpoints) {
      if (!endpoint.clusterIds.includes(MatterClusterId.DoorLock)) continue
      if (endpoint.lockUnbolting !== undefined) continue
      this.#logger.warn(
        'Matter: DoorLock FeatureMap could not be read — unknown, Open not offered',
        {
          tags: deviceId !== null ? { deviceId } : { addonId: 'matter-broker' },
          meta: { brokerId, nodeId: node.nodeId, endpointId: endpoint.endpointId },
        },
      )
    }
    for (const line of inventory) {
      if (line.deviceTypeIds.length === 0 || line.clusterIds.length > 0) continue
      this.#logger.warn('Matter: endpoint has device types but no server clusters', {
        tags: deviceId !== null ? { deviceId } : { addonId: 'matter-broker' },
        meta: {
          brokerId,
          nodeId: node.nodeId,
          endpointId: line.endpointId,
          deviceTypeIds: line.deviceTypeIds,
          reason: 'no behavior with a cluster id and no Descriptor serverList in the peer state',
        },
      })
    }
    this.#logger.info('Matter: node endpoints read', {
      tags: deviceId !== null ? { deviceId } : { addonId: 'matter-broker' },
      meta: {
        brokerId,
        nodeId: node.nodeId,
        endpointCount: inventory.length,
        endpoints: inventory,
      },
    })
  }
}

/** One adopted node Container as the reconcile sees it. */
export interface AdoptedNodeConfig {
  readonly id: number
  readonly config: Record<string, unknown>
}

export interface ReconcileDeps {
  readonly logger: IScopedLogger
  readonly reporter: NodeEndpointReporter
  readonly loadAdopted: () => Promise<readonly AdoptedNodeConfig[]>
  readonly applyEndpoints: (deviceId: number, endpoints: MatterEndpointEntry[]) => Promise<void>
  /** A successful re-read agreed with the persisted list: advance the node's probe stamp. */
  readonly markEndpointsRead: (deviceId: number) => void
}

/**
 * Re-derive every adopted node Container's `endpoints[]` from the live node
 * inventory; a changed set is re-persisted through `applyEndpoints` (the kernel
 * then re-runs `getAccessoryChildren()`: new children appear, orphans go).
 * Best-effort; never throws.
 */
export async function reconcileNodeEndpoints(
  deps: ReconcileDeps,
  brokerId: string,
  nodes: readonly MatterNodeSnapshot[],
): Promise<void> {
  try {
    const adopted = await deps.loadAdopted()
    const byNode = new Map<string, MatterNodeSnapshot>()
    for (const n of nodes) byNode.set(n.nodeId, n)
    const adoptedNodeIds = new Set<string>()

    for (const d of adopted) {
      const cfg = d.config
      if (cfg['system'] !== 'matter' || cfg['brokerId'] !== brokerId) continue
      const nodeId = String(cfg['nodeId'])
      adoptedNodeIds.add(nodeId)
      const node = byNode.get(nodeId)
      if (node === undefined) continue
      deps.reporter.report(brokerId, node, d.id)

      const { entries: nextEndpoints, fold } = planEndpoints(node)
      const current = Array.isArray(cfg['endpoints']) ? cfg['endpoints'] : []
      if (endpointsEqual(current, nextEndpoints)) {
        if (node.online && node.endpoints.length > 0) deps.markEndpointsRead(d.id)
        continue
      }

      if (fold.kind !== 'none') {
        deps.logger.info(
          fold.kind === 'folded'
            ? 'Matter: PowerSource endpoint folded into the functional endpoint'
            : 'Matter: PowerSource endpoint kept as its own child (fold is ambiguous)',
          { tags: { deviceId: d.id }, meta: { brokerId, nodeId: node.nodeId, ...fold } },
        )
      }

      await deps.applyEndpoints(d.id, nextEndpoints)
      deps.logger.info('Matter: node endpoints reconciled', {
        tags: { deviceId: d.id },
        meta: { brokerId, endpointCount: nextEndpoints.length },
      })
    }
    for (const node of nodes) {
      if (!adoptedNodeIds.has(node.nodeId)) deps.reporter.report(brokerId, node, null)
    }
  } catch (err) {
    deps.logger.warn('Matter: node endpoint reconcile failed', {
      meta: { brokerId, error: errMsg(err) },
    })
  }
}
