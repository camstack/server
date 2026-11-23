/**
 * Everything the onboarding steps are judged from, read once per `setup_wizard`
 * call: what this machine remembers from before the install, and — when a hub
 * answers — what the hub says about itself.
 *
 * A read that failed stays a failed `Read` with its reason all the way to the
 * step that needs it (D315, D393): it is never an empty list and never zero.
 * Every wrapper strips what the steps do not need, so nothing here can carry a
 * credential into an answer.
 */
import type { ConnectOutcome, HubConnection } from '@camstack/develop'
import { StorageLocationSchema, type StorageLocation } from '@camstack/types'
import { z } from 'zod'
import { readCameras, type CameraRef } from '../mcp/configure-common.js'
import { readTargets, type TargetRef } from '../mcp/configure-hub-reads.js'
import type { McpContext } from '../mcp/context.js'
import { ADMIN_ONLY_NOTE, readQuery, reasonOf, type Read } from '../mcp/ops-hub.js'
import { TopologySchema } from '../mcp/ops-status.js'
import {
  assessCoreAddons,
  toolServed,
  type CoreAddonsAssessment,
} from '../mcp/setup-core-addons.js'
import {
  readBackupDestinations,
  readCameraSetup,
  readDefaultPasswordInUse,
  readPasskeyCount,
  readPublicEndpoint,
  readRemoteAccessStatus,
  readRules,
  readUsers,
  type BackupFact,
  type CameraSetupFact,
  type RemoteAccessFact,
  type RuleFact,
  type UserFact,
} from '../mcp/setup-wizard-reads.js'
import { probeVersions, type VersionProbe } from '../mcp/version-probe.js'
import { stateOf } from './context.js'
import type { OnboardingManifest } from './manifest-schema.js'
import type { RememberedFeasibility } from './state-file.js'

export const PASSKEY_ADMIN_LIMIT = 10
const INSTALL_TOOL = 'configure_addon_install'

/**
 * One node's measured capacity, as `pipelineOrchestrator.getNodeCapacityVerdict`
 * answers it: how many streams it decodes, how many detection sessions it runs,
 * and which of the two is the limit. Loose on purpose: a newer hub may add
 * fields. A plane nobody measured is `null`, never 0.
 */
export const NodeCapacitySchema = z.looseObject({
  nodeId: z.string(),
  detection: z.looseObject({ maxSessions: z.number() }).nullable(),
  decode: z
    .looseObject({
      maxStreams: z.number(),
      profile: z.looseObject({
        width: z.number(),
        height: z.number(),
        fps: z.number(),
        codec: z.string(),
      }),
      hardware: z.boolean(),
      decoder: z.string(),
    })
    .nullable(),
  capacity: z.number().nullable(),
  limitedBy: z.enum(['decode', 'detection']).nullable(),
  complete: z.boolean(),
})
export type NodeCapacity = z.infer<typeof NodeCapacitySchema>

export interface NodeCounts {
  readonly hubId: string | null
  readonly agents: number
  readonly agentsOnline: number
}

export interface HubFacts {
  readonly server: string
  readonly tier: string
  readonly adminHint: string | null
  /** The saved session this hub is read as (`user@host, scope x`); absent for a token. */
  readonly actingAs: string | null
  readonly users: Read<readonly UserFact[]>
  /** Passkey count per admin id; an admin whose read failed is absent. */
  readonly passkeys: ReadonlyMap<string, number>
  readonly passkeysFailed: number
  readonly passkeysSkipped: number
  /** Whether an admin still has the first-boot password (D728, D797). */
  readonly defaultPassword: Read<boolean>
  readonly publicEndpoint: Read<boolean>
  readonly remoteAccess: Read<RemoteAccessFact>
  readonly backups: Read<readonly BackupFact[]>
  readonly cameras: Read<readonly CameraRef[]>
  /** Per enabled camera: recording on, main/sub assigned. */
  readonly cameraSetup: Read<readonly CameraSetupFact[]>
  readonly nodes: Read<NodeCounts>
  readonly targets: Read<readonly TargetRef[]>
  readonly rules: Read<readonly RuleFact[]>
  readonly locations: Read<readonly StorageLocation[]>
  readonly capacity: Read<readonly NodeCapacity[]>
  readonly coreAddons: CoreAddonsAssessment
  readonly versions: VersionProbe | null
}

export interface NoSessionFacts {
  readonly ok: false
  /** `no-session`: nobody is signed in here; `unreachable`: a hub is configured and did not answer. */
  readonly kind: 'no-session' | 'unreachable'
  readonly message: string
  readonly action: string
}

export interface SessionFacts {
  readonly ok: true
  readonly hub: HubFacts
}

export interface OnboardingFacts {
  /** The feasibility verdict this machine remembers; null when none was run here. */
  readonly remembered: RememberedFeasibility | null
  /** What the person said about opening CamStack away from home; null = not asked. */
  readonly remoteAccess: boolean | null
  readonly session: NoSessionFacts | SessionFacts
}

async function gatherHub(
  connection: HubConnection,
  ctx: McpContext,
  manifest: OnboardingManifest,
  remoteAccess: boolean | null,
): Promise<HubFacts> {
  const { client } = connection
  const admin = connection.tier === 'admin'
  const refused = <T>(path: string): Promise<Read<T>> =>
    Promise.resolve({
      ok: false,
      reason: ADMIN_ONLY_NOTE(path, connection.adminHint),
    })
  const [
    users,
    backups,
    rules,
    topology,
    publicEndpoint,
    remote,
    cameras,
    cameraSetup,
    targets,
    versions,
    defaultPassword,
    locations,
    capacity,
    coreAddons,
  ] = await Promise.all([
    admin ? readUsers(client) : refused<readonly UserFact[]>('userManagement.listUsers'),
    admin
      ? readBackupDestinations(client)
      : refused<readonly BackupFact[]>('backup.listDestinations'),
    admin ? readRules(client) : refused<readonly RuleFact[]>('notificationRules.listRules'),
    admin
      ? readQuery(client, 'nodes.topology', undefined, TopologySchema)
      : refused<z.infer<typeof TopologySchema>>('nodes.topology'),
    readPublicEndpoint(client),
    readRemoteAccessStatus(client),
    readCameras(client),
    readCameraSetup(client),
    readTargets(client),
    probeVersions(ctx).catch(() => null),
    admin
      ? readDefaultPasswordInUse(client)
      : refused<boolean>('userManagement.getAdminBootstrapStatus'),
    readQuery(client, 'storage.listLocations', {}, z.array(StorageLocationSchema)),
    admin
      ? readQuery(
          client,
          'pipelineOrchestrator.getNodeCapacityVerdict',
          {},
          z.array(NodeCapacitySchema),
        )
      : refused<readonly NodeCapacity[]>('pipelineOrchestrator.getNodeCapacityVerdict'),
    assessCoreAddons(
      client,
      manifest.coreAddons,
      remoteAccess,
      await toolServed(ctx, INSTALL_TOOL),
    ),
  ])
  const passkeys = new Map<string, number>()
  let passkeysFailed = 0
  let passkeysSkipped = 0
  if (users.ok) {
    const admins = users.value.filter((u) => u.isAdmin && !u.totpEnabled)
    const checked = admins.slice(0, PASSKEY_ADMIN_LIMIT)
    passkeysSkipped = admins.length - checked.length
    const counts = await Promise.all(checked.map((u) => readPasskeyCount(client, u.id)))
    counts.forEach((c, i) => {
      const u = checked[i]
      if (u === undefined) return
      if (c.ok) passkeys.set(u.id, c.value)
      else passkeysFailed += 1
    })
  }
  const nodes: Read<NodeCounts> = topology.ok
    ? {
        ok: true,
        value: {
          hubId: topology.value.find((n) => n.isHub === true)?.id ?? null,
          agents: topology.value.filter((n) => n.isHub !== true).length,
          agentsOnline: topology.value.filter((n) => n.isHub !== true && n.isOnline === true)
            .length,
        },
      }
    : topology
  return {
    server: connection.server,
    tier: connection.tier,
    adminHint: connection.adminHint,
    actingAs: connection.actingAs ?? null,
    users,
    passkeys,
    passkeysFailed,
    passkeysSkipped,
    defaultPassword,
    publicEndpoint,
    remoteAccess: remote,
    backups,
    cameras,
    cameraSetup,
    nodes,
    targets,
    rules,
    locations,
    capacity,
    coreAddons,
    versions,
  }
}

export async function gatherFacts(
  ctx: McpContext,
  manifest: OnboardingManifest,
  remoteAccess: boolean | null,
): Promise<OnboardingFacts> {
  const remembered = stateOf(ctx).read().feasibility
  // A hub that is configured but does not answer (TLS, a refused refresh) throws:
  // for the flow that is the same place as no session — the reason is what differs.
  let outcome: ConnectOutcome
  try {
    outcome = await ctx.hub()
  } catch (err) {
    return {
      remembered,
      remoteAccess,
      session: {
        ok: false,
        kind: 'unreachable',
        message: `the hub this machine is logged in to did not answer: ${reasonOf(err)}`,
        action: 'check that the hub is running, then call setup_connect with its address',
      },
    }
  }
  if (!outcome.ok) {
    return {
      remembered,
      remoteAccess,
      session: {
        ok: false,
        kind: 'no-session',
        message: outcome.message,
        action: outcome.action,
      },
    }
  }
  return {
    remembered,
    remoteAccess,
    session: {
      ok: true,
      hub: await gatherHub(outcome.connection, ctx, manifest, remoteAccess),
    },
  }
}
