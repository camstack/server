/**
 * Record kinds owned by cluster-agent (phase 4 — hub-main).
 */
import { defineRecordKinds, type DefinedRecordKind, type RecordKindSpec } from '@camstack/types'
import { z } from 'zod'
import type { IsolatedRecordKinds } from '../records-isolated.js'

export interface ClusterNodePackageEntryBody {
  readonly name: string
  readonly version: string | null
}

export interface ClusterNodeDescriptorBody {
  readonly id: string
  readonly name: string
  readonly hostname: string
  readonly platform: string
  readonly arch: string
  readonly cpuModel: string | null
  readonly cpuCores: number
  readonly memoryMB: number
  readonly engines: readonly string[]
  readonly isHub: boolean
  readonly localIps: readonly string[]
  readonly addonIds: readonly string[]
  readonly packages?: readonly ClusterNodePackageEntryBody[]
}

export interface ClusterNodeHistoryBody {
  readonly descriptor: ClusterNodeDescriptorBody
}

const NodePackageEntrySchema = z.object({
  name: z.string(),
  version: z.string().nullable(),
})

const _clusterNodeDescriptorBody: z.ZodType<ClusterNodeDescriptorBody> = z.object({
  id: z.string(),
  name: z.string(),
  hostname: z.string(),
  platform: z.string(),
  arch: z.string(),
  cpuModel: z.string().nullable(),
  cpuCores: z.number(),
  memoryMB: z.number(),
  engines: z.array(z.string()).readonly(),
  isHub: z.boolean(),
  localIps: z.array(z.string()).readonly(),
  addonIds: z.array(z.string()).readonly(),
  packages: z.array(NodePackageEntrySchema).readonly().optional(),
})
export const ClusterNodeDescriptorBodySchema: z.ZodType<ClusterNodeDescriptorBody> =
  _clusterNodeDescriptorBody

const _clusterNodeHistoryBody: z.ZodType<ClusterNodeHistoryBody> = z.object({
  descriptor: _clusterNodeDescriptorBody,
})
export const ClusterNodeHistoryBodySchema: z.ZodType<ClusterNodeHistoryBody> =
  _clusterNodeHistoryBody

const clusterNodeHistoryKindSpec: RecordKindSpec<z.ZodType<ClusterNodeHistoryBody>> = {
  schema: ClusterNodeHistoryBodySchema,
  class: 'ledger',
  writeTrigger:
    'gated snapshot on topology poll, touch on disconnect, recordPackages / prunePackages',
  device: 'none',
  at: 'required',
  indexes: [{ name: 'last_active', fields: ['at'] }],
  retention: {
    none: 'rows removed only by operator forget(nodeId)',
  },
}

/**
 * A forgotten node (`node-removal-hook`): the recorded fact the hub drives the
 * hook from. `pending` lists the implementers that have not acknowledged yet;
 * the row is deleted when it is empty.
 */
export interface ClusterNodeTombstoneBody {
  readonly removedAt: number
  readonly pending: readonly string[]
}

export const ClusterNodeTombstoneBodySchema: z.ZodType<ClusterNodeTombstoneBody> = z.object({
  removedAt: z.number(),
  pending: z.array(z.string()).readonly(),
})

const clusterNodeTombstoneKindSpec: RecordKindSpec<z.ZodType<ClusterNodeTombstoneBody>> = {
  schema: ClusterNodeTombstoneBodySchema,
  class: 'ledger',
  writeTrigger: 'operator forget(nodeId); one write per implementer acknowledgement',
  device: 'none',
  at: 'required',
  indexes: [],
  retention: {
    none: 'row deleted when every node-removal-hook implementer has acknowledged',
  },
}

const _clusterAgentRecordKinds = defineRecordKinds({
  'node-history': clusterNodeHistoryKindSpec,
  'node-tombstones': clusterNodeTombstoneKindSpec,
}) satisfies IsolatedRecordKinds

export type ClusterAgentRecordKindsMap = {
  readonly 'node-history': DefinedRecordKind<z.ZodType<ClusterNodeHistoryBody>>
  readonly 'node-tombstones': DefinedRecordKind<z.ZodType<ClusterNodeTombstoneBody>>
}

export const clusterAgentRecordKinds: ClusterAgentRecordKindsMap = _clusterAgentRecordKinds

/** Narrow kind for `records.kind()` — `IsolatedRecordKinds` string index is `| undefined`. */
export const clusterNodeHistoryRecordKind: DefinedRecordKind<z.ZodType<ClusterNodeHistoryBody>> =
  _clusterAgentRecordKinds['node-history']

export const clusterNodeTombstoneRecordKind: DefinedRecordKind<
  z.ZodType<ClusterNodeTombstoneBody>
> = _clusterAgentRecordKinds['node-tombstones']
