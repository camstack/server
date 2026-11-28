/**
 * `configure_setup_location_create`: add a storage location on a local path —
 * a second recording disk, a mounted NAS share — through the door the admin UI
 * uses (`integrationInstances.createInstance` of the storage orchestrator).
 *
 * The hub stays the authority: it resolves the real root and refuses two
 * locations of one type on one physical root (D388, D389). What the dry run
 * adds is the same refusal BEFORE the operator is asked to confirm, from the
 * rows the hub listed: the type is declared, a `single` type has no location
 * yet, and no location of the same type on the same node has a path that is
 * equal to, inside or around the new one. Two different types may share a
 * disk — each keeps its own class subtree.
 *
 * Local paths only. A location that needs a password or a key (SMB, SFTP, S3,
 * WebDAV) is created by the person in the admin UI: a secret never crosses a
 * tool call.
 */
import * as path from 'node:path'
import {
  StorageLocationDeclarationSchema,
  StorageLocationModeSchema,
  StorageLocationSchema,
  type StorageLocation,
  type StorageLocationMode,
} from '@dominevo/types'
import type { DryRunOutcome, GatedToolSpec, HubClient } from '@dominevo/develop'
import { z } from 'zod'
import { adminGated, type AdminGatedResult } from './configure-common.js'
import type { McpContext } from './context.js'
import { readQuery } from './ops-hub.js'

export const LOCATION_CREATE_TOOL = 'configure_setup_location_create'
const STORAGE_ORCHESTRATOR_ADDON_ID = 'storage-orchestrator'
export const LOCAL_PROVIDER_ID = 'filesystem-storage'
const HUB_NODE = 'hub'

export const LocationCreateArgsShape = {
  type: z
    .string()
    .min(1)
    .describe('The location type, as setup_locations lists it (recordings, eventMedia, …).'),
  name: z.string().min(1).max(80).describe('The name shown in the admin UI.'),
  path: z
    .string()
    .min(1)
    .describe(
      'An absolute path AS THE NODE SEES IT (inside the container: the mount target, not the host path).',
    ),
  nodeId: z.string().min(1).optional().describe('The node the path is on; absent means the hub.'),
  mode: StorageLocationModeSchema.optional().describe('Absent means active.'),
} as const

export interface LocationCreateArgs {
  readonly type: string
  readonly name: string
  readonly path: string
  readonly nodeId?: string
  readonly mode?: StorageLocationMode
}

const LocationListSchema = z.array(StorageLocationSchema)
const DeclarationListSchema = z.array(StorageLocationDeclarationSchema)
const ProbeSchema = z.looseObject({
  success: z.boolean().optional(),
  status: z.string().optional(),
  error: z.string().optional(),
})
const CreatedSchema = z.looseObject({ id: z.string() })

/** `/a/b/` → `/a/b`; null when the path is not absolute. */
export function normalizedRoot(raw: string): string | null {
  if (!raw.startsWith('/')) return null
  const normal = path.posix.normalize(raw)
  return normal.length > 1 && normal.endsWith('/') ? normal.slice(0, -1) : normal
}

const within = (outer: string, inner: string): boolean =>
  outer === inner || outer === '/' || inner.startsWith(`${outer}/`)

function localRootOf(row: StorageLocation): string | null {
  const base = row.config['basePath']
  return typeof base === 'string' ? normalizedRoot(base) : null
}

/** The same-type, same-node locations whose root equals, contains or sits inside `root`. */
export function rootCollisions(
  rows: readonly StorageLocation[],
  type: string,
  nodeId: string,
  root: string,
): readonly StorageLocation[] {
  return rows.filter((row) => {
    if (row.type !== type || (row.nodeId ?? HUB_NODE) !== nodeId) return false
    const other = localRootOf(row)
    return other !== null && (within(other, root) || within(root, other))
  })
}

function valuesOf(args: LocationCreateArgs, root: string): { readonly [key: string]: unknown } {
  return {
    providerId: LOCAL_PROVIDER_ID,
    basePath: root,
    nodeId: args.nodeId ?? HUB_NODE,
    mode: args.mode ?? 'active',
  }
}

export function locationCreateSpec(client: HubClient): GatedToolSpec<LocationCreateArgs> {
  return {
    tool: LOCATION_CREATE_TOOL,
    async dryRun(args): Promise<DryRunOutcome> {
      const [locations, declarations] = await Promise.all([
        readQuery(client, 'storage.listLocations', {}, LocationListSchema),
        readQuery(client, 'storage.listLocationDeclarations', undefined, DeclarationListSchema),
      ])
      // A read that failed confirms nothing: no rows is not "no collision".
      if (!locations.ok) return { confirmable: false, describe: { problem: locations.reason } }
      if (!declarations.ok)
        return {
          confirmable: false,
          describe: { problem: declarations.reason },
        }

      const problems: string[] = []
      const nodeId = args.nodeId ?? HUB_NODE
      const root = normalizedRoot(args.path)
      if (root === null) problems.push(`path must be absolute, got '${args.path}'`)
      const declared = declarations.value.find((d) => d.id === args.type)
      if (declared === undefined) {
        problems.push(
          `'${args.type}' is not a location type of this hub; the types are: ${declarations.value.map((d) => d.id).join(', ')}`,
        )
      }
      const sameType = locations.value.filter((l) => l.type === args.type)
      if (declared?.cardinality === 'single' && sameType.length > 0) {
        problems.push(
          `${args.type} holds only one location and it exists (${sameType.map((l) => l.id).join(', ')}); change that one in the admin UI instead`,
        )
      }
      if (root !== null) {
        for (const hit of rootCollisions(locations.value, args.type, nodeId, root)) {
          problems.push(
            `${hit.id} is a ${args.type} location on ${nodeId} at ${localRootOf(hit) ?? '?'}: two locations of one type never share a root, and one may not sit inside the other`,
          )
        }
      }
      const shared =
        root === null
          ? []
          : locations.value.filter(
              (l) =>
                l.type !== args.type &&
                (l.nodeId ?? HUB_NODE) === nodeId &&
                localRootOf(l) === root,
            )
      return {
        confirmable: problems.length === 0,
        describe: {
          action: 'create storage location',
          create: {
            type: args.type,
            name: args.name,
            nodeId,
            path: root ?? args.path,
            mode: args.mode ?? 'active',
            provider: LOCAL_PROVIDER_ID,
          },
          notes: [
            'The path is read on the node itself: in a container it is the mount target, not the host path.',
            'The hub checks the path is writable before it creates anything, and refuses a root already used by this type.',
            ...(shared.length > 0
              ? [
                  `${shared.map((l) => l.id).join(', ')} already uses this path for another type; each type keeps its own subfolder.`,
                ]
              : []),
          ],
          ...(problems.length > 0 ? { problems } : {}),
        },
      }
    },
    async execute(args) {
      const root = normalizedRoot(args.path)
      if (root === null) throw new Error(`path must be absolute, got '${args.path}'`)
      const values = valuesOf(args, root)
      const probe = ProbeSchema.safeParse(
        await client.call('POST', 'integrationInstances.testInstance', {
          addonId: STORAGE_ORCHESTRATOR_ADDON_ID,
          id: null,
          kind: args.type,
          values,
        }),
      )
      if (probe.success && probe.data.status === 'rejected') {
        throw new Error(
          `the node refused ${root}: ${probe.data.error ?? 'no reason given'}. Nothing was created.`,
        )
      }
      const created = CreatedSchema.safeParse(
        await client.call('POST', 'integrationInstances.createInstance', {
          addonId: STORAGE_ORCHESTRATOR_ADDON_ID,
          name: args.name,
          kind: args.type,
          values,
        }),
      )
      return {
        created: created.success ? created.data.id : null,
        // `validated` is the only word that means the path was really written to.
        pathCheck: probe.success ? (probe.data.status ?? 'unknown') : 'unknown',
        ...(probe.success && probe.data.error !== undefined
          ? { pathCheckDetail: probe.data.error }
          : {}),
      }
    },
  }
}

export function locationCreateApply(
  ctx: McpContext,
  args: LocationCreateArgs,
  confirmToken: string | undefined,
): Promise<AdminGatedResult> {
  return adminGated(ctx, locationCreateSpec, args, confirmToken)
}
