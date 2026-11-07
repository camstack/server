/**
 * `setup_locations` (read) and `configure_setup_locations` (write): storage
 * locations per class, their occupancy and mode, and a proposal built from the
 * volumes the hub can see.
 *
 * Absence is an answer (D315, D393): a location nobody reported occupancy for
 * has `ownedBytes: null` (unknown), never 0; a capacity the hub could not read
 * is `null`. The hub offers no way to enumerate the disks of a node that no
 * location points at, so the proposal works from the volumes locations already
 * sit on and says so.
 */
import {
  StorageDrainProgressSchema,
  StorageLocationDeclarationSchema,
  StorageLocationSchema,
  StorageLocationModeSchema,
  mayWriteToLocation,
  resolveLocationMode,
  withLocationMode,
  type StorageLocation,
  type StorageLocationMode,
} from '@camstack/types'
import { type DryRunOutcome, type GatedToolSpec, type HubClient } from '@camstack/develop'
import { z } from 'zod'
import { adminGated, type AdminGatedResult } from './configure-common.js'
import type { McpContext } from './context.js'
import { readQuery, withHub, type NoSessionResult, type Read } from './ops-hub.js'
import { proposalId } from './setup-assist-common.js'

export const LOW_FREE_FRACTION = 0.1

export interface LocationView {
  readonly id: string
  readonly displayName: string
  readonly providerId: string
  readonly nodeId: string | null
  readonly mode: StorageLocationMode
  /** `null`: the hub could not read the volume (remote, unreachable) — unknown. */
  readonly capacity: { readonly totalBytes: number; readonly availableBytes: number } | null
  /** `null`: no provider reported for this location — unknown, never zero. */
  readonly ownedBytes: number | null
  readonly ownedMeasuredAtMs: number | null
  readonly drain: {
    readonly bytesRemaining: number
    readonly drained: boolean
    readonly estimatedEmptyAtMs: number | null
  } | null
}

export interface LocationClassView {
  readonly type: string
  readonly displayName: string | null
  readonly cardinality: 'single' | 'multi' | null
  readonly locations: readonly LocationView[]
}

export interface LocationChange {
  readonly locationId: string
  readonly mode: StorageLocationMode
}

export interface LocationsProposal {
  readonly id: string
  readonly changes: readonly (LocationChange & { readonly reason: string })[]
  readonly notes: readonly string[]
}

export interface SetupLocationsResult {
  readonly status: 'ok'
  readonly classes: readonly LocationClassView[]
  readonly proposal: LocationsProposal
  readonly unavailable: { readonly [part: string]: string }
}

const LocationListSchema = z.array(StorageLocationSchema)
const DeclarationListSchema = z.array(StorageLocationDeclarationSchema)
const DrainListSchema = z.array(StorageDrainProgressSchema)

export function viewOf(
  row: StorageLocation,
  drain: readonly z.infer<typeof StorageDrainProgressSchema>[] | null,
): LocationView {
  const progress = drain?.find((d) => d.locationId === row.id) ?? null
  return {
    id: row.id,
    displayName: row.displayName,
    providerId: row.providerId,
    nodeId: row.nodeId ?? null,
    mode: resolveLocationMode(row),
    capacity: row.capacity ?? null,
    ownedBytes: row.owned?.bytes ?? null,
    ownedMeasuredAtMs: row.owned?.measuredAtMs ?? null,
    drain: progress
      ? {
          bytesRemaining: progress.bytesRemaining,
          drained: progress.drained,
          estimatedEmptyAtMs: progress.estimatedEmptyAtMs,
        }
      : null,
  }
}

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`

/** Pure: a proposal from the classes the hub reported. Conservative by construction. */
export function proposeLocations(classes: readonly LocationClassView[]): LocationsProposal {
  const changes: (LocationChange & { reason: string })[] = []
  const notes: string[] = []
  for (const cls of classes) {
    const writable = cls.locations.filter((l) => l.mode === 'active')
    if (cls.locations.length === 0) {
      notes.push(`${cls.type}: no location is configured`)
      continue
    }
    if (writable.length === 0) {
      const candidate = cls.locations.find((l) => l.mode === 'readonly')
      if (candidate) {
        changes.push({
          locationId: candidate.id,
          mode: 'active',
          reason: `${cls.type} has no location accepting writes; ${candidate.id} is read-only`,
        })
      } else {
        notes.push(`${cls.type}: no location accepts writes and none is read-only to re-enable`)
      }
    }
    for (const l of cls.locations) {
      if (l.capacity === null) {
        notes.push(`${l.id}: capacity unknown (remote or unreachable volume)`)
        continue
      }
      const free = l.capacity.availableBytes / l.capacity.totalBytes
      if (l.mode === 'active' && free < LOW_FREE_FRACTION) {
        notes.push(
          `${l.id}: only ${gb(l.capacity.availableBytes)} free of ${gb(l.capacity.totalBytes)} — add a location on a larger volume`,
        )
      }
    }
  }
  const volumes = new Map<string, string[]>()
  for (const cls of classes) {
    for (const l of cls.locations) {
      if (l.capacity === null) continue
      const key = `${l.nodeId ?? 'any'}|${String(l.capacity.totalBytes)}`
      volumes.set(key, [...(volumes.get(key) ?? []), l.id])
    }
  }
  for (const ids of volumes.values()) {
    const types = new Set(ids.map((id) => id.split(':')[0]))
    if (types.size > 1) notes.push(`${ids.join(', ')} report the same volume size: likely one disk`)
  }
  notes.push(
    'No capability lists the disks of a node that no location points at; a new location needs a path you choose (configure_setup_locations only changes the mode of existing ones).',
  )
  const body = { changes, notes }
  return { id: proposalId(body), changes, notes }
}

export async function setupLocations(
  ctx: McpContext,
): Promise<SetupLocationsResult | NoSessionResult> {
  return withHub(ctx, async ({ client }): Promise<SetupLocationsResult> => {
    const [locations, declarations, drain] = await Promise.all([
      readQuery(client, 'storage.listLocations', {}, LocationListSchema),
      readQuery(client, 'storage.listLocationDeclarations', undefined, DeclarationListSchema),
      readQuery(client, 'storage.listDrainProgress', undefined, DrainListSchema),
    ])
    const unavailable: { [part: string]: string } = {}
    if (!locations.ok) unavailable['locations'] = locations.reason
    if (!declarations.ok) unavailable['declarations'] = declarations.reason
    if (!drain.ok) unavailable['drain'] = drain.reason
    const rows = locations.ok ? locations.value : []
    const drainRows = drain.ok ? drain.value : null
    const types = [...new Set(rows.map((r) => r.type))].toSorted()
    const classes = types.map((type): LocationClassView => {
      const decl = declarations.ok ? declarations.value.find((d) => d.id === type) : undefined
      return {
        type,
        displayName: decl?.displayName ?? null,
        cardinality: decl?.cardinality ?? null,
        locations: rows.filter((r) => r.type === type).map((r) => viewOf(r, drainRows)),
      }
    })
    // A failed read proposes nothing: no locations is not "no locations configured".
    const proposal: LocationsProposal = locations.ok
      ? proposeLocations(classes)
      : { id: proposalId({ unknown: true }), changes: [], notes: ['locations could not be read'] }
    return { status: 'ok', classes, proposal, unavailable }
  })
}

// ---------------------------------------------------------------------------
// configure_setup_locations

export const SETUP_LOCATIONS_TOOL = 'configure_setup_locations'
export const MAX_LOCATION_CHANGES = 10

export const LocationChangeSchema = z.object({
  locationId: z.string().min(1),
  mode: StorageLocationModeSchema,
})

export interface SetupLocationsArgs {
  readonly changes: readonly LocationChange[]
}

/** The whole persisted row, minus what the hub computes, rebuilt from the row read. */
/** The storage-orchestrator owns the location instances; the mode is the one value the call patches. */
const STORAGE_ORCHESTRATOR_ADDON_ID = 'storage-orchestrator'

async function readRows(client: HubClient): Promise<Read<readonly StorageLocation[]>> {
  return readQuery(client, 'storage.listLocations', {}, LocationListSchema)
}

export function setupLocationsSpec(client: HubClient): GatedToolSpec<SetupLocationsArgs> {
  return {
    tool: SETUP_LOCATIONS_TOOL,
    async dryRun(args): Promise<DryRunOutcome> {
      const read = await readRows(client)
      if (!read.ok) {
        return { confirmable: false, describe: { problem: read.reason } }
      }
      const rows = read.value
      const diff: { [k: string]: unknown }[] = []
      const problems: string[] = []
      for (const change of args.changes) {
        const row = rows.find((r) => r.id === change.locationId)
        if (!row) {
          problems.push(`${change.locationId}: not found`)
          continue
        }
        const from = resolveLocationMode(row)
        if (from === change.mode) {
          problems.push(`${change.locationId}: already ${from}`)
          continue
        }
        diff.push({ locationId: row.id, nodeId: row.nodeId ?? null, from, to: change.mode })
      }
      const after = rows.map((r) => {
        const change = args.changes.find((c) => c.locationId === r.id)
        return change ? withLocationMode(r, change.mode) : r
      })
      for (const type of new Set(rows.map((r) => r.type))) {
        const hadWriter = rows.some((r) => r.type === type && mayWriteToLocation(r))
        const hasWriter = after.some((r) => r.type === type && mayWriteToLocation(r))
        if (hadWriter && !hasWriter) {
          problems.push(`${type}: this would leave no location accepting writes`)
        }
      }
      return {
        confirmable: problems.length === 0 && diff.length > 0,
        describe: {
          action: 'set storage location mode',
          diff,
          ...(problems.length > 0 ? { problems } : {}),
        },
      }
    },
    async execute(args) {
      const read = await readRows(client)
      if (!read.ok) throw new Error(read.reason)
      const done: string[] = []
      for (const change of args.changes) {
        const row = read.value.find((r) => r.id === change.locationId)
        if (!row) throw new Error(`${change.locationId}: not found`)
        await client.call('POST', 'integrationInstances.updateInstance', {
          addonId: STORAGE_ORCHESTRATOR_ADDON_ID,
          id: row.id,
          values: { mode: change.mode },
        })
        done.push(change.locationId)
      }
      return { changed: done }
    },
  }
}

export function setupLocationsApply(
  ctx: McpContext,
  args: SetupLocationsArgs,
  confirmToken: string | undefined,
): Promise<AdminGatedResult> {
  return adminGated(ctx, setupLocationsSpec, args, confirmToken)
}
