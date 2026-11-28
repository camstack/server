/**
 * The hub reads behind `setup_wizard`. Every schema is loose (a newer hub may
 * add fields) and every wrapper strips what the wizard does not need: a user
 * is reduced to id / isAdmin / totpEnabled, a target to id / name / kind, a
 * backup destination to its enabled flag, cadence and last success. Nothing
 * here can carry a credential into an answer.
 */
import type { HubClient } from '@dominevo/develop'
import {
  CameraStreamSchema,
  ProfileSlotSchema,
  RecordingConfigSchema,
  deriveRecordingMode,
  type CamProfile,
  type RecordingStorageMode,
} from '@dominevo/types'
import { z } from 'zod'
import { readQuery, type Read } from './ops-hub.js'
import { READ_CONCURRENCY, mapLimit } from './setup-assist-common.js'
import { readCameraRows } from './setup-camera-reads.js'
import { unassignedProfiles } from './setup-streams.js'

const UserListSchema = z.array(
  z.looseObject({
    id: z.string(),
    isAdmin: z.boolean().optional(),
    totpEnabled: z.boolean().optional(),
  }),
)

export interface UserFact {
  readonly id: string
  readonly isAdmin: boolean
  readonly totpEnabled: boolean
}

export async function readUsers(client: HubClient): Promise<Read<readonly UserFact[]>> {
  const read = await readQuery(client, 'userManagement.listUsers', undefined, UserListSchema)
  if (!read.ok) return read
  return {
    ok: true,
    value: read.value.map((u) => ({
      id: u.id,
      isAdmin: u.isAdmin === true,
      totpEnabled: u.totpEnabled === true,
    })),
  }
}

const BootstrapStatusSchema = z.looseObject({
  defaultPasswordInUse: z.boolean(),
})

/** Whether an admin still signs in with the first-boot password; one boolean, nothing else. */
export async function readDefaultPasswordInUse(client: HubClient): Promise<Read<boolean>> {
  const read = await readQuery(
    client,
    'userManagement.getAdminBootstrapStatus',
    undefined,
    BootstrapStatusSchema,
  )
  return read.ok ? { ok: true, value: read.value.defaultPasswordInUse } : read
}

const PasskeyListSchema = z.array(z.looseObject({ credentialId: z.string() }))

/** How many passkeys one user has registered; the credential ids are dropped. */
export async function readPasskeyCount(client: HubClient, userId: string): Promise<Read<number>> {
  const read = await readQuery(client, 'userPasskeys.listPasskeys', { userId }, PasskeyListSchema)
  return read.ok ? { ok: true, value: read.value.length } : read
}

const AddressesSchema = z.looseObject({
  roles: z
    .looseObject({
      publicEndpoint: z.looseObject({ resolved: z.unknown().optional() }).optional(),
    })
    .optional(),
})

const PRIVATE_HOST_SUFFIXES: readonly string[] = [
  '.local',
  '.lan',
  '.home.arpa',
  '.internal',
  '.localdomain',
]

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false
  }
  const [a = 0, b = 0] = parts
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  )
}

/**
 * Whether a hub address is one the outside world can use: an https address
 * whose host is not loopback, a LAN/private range, a local name or a
 * single-label name. A plain-http address (the hub's own LAN port) is never a
 * public endpoint. The ONE judgement behind the remote-access step and the
 * remote group of the core addons: two copies would disagree on the same hub.
 */
export function isPublicEndpoint(resolved: unknown): boolean {
  if (typeof resolved !== 'string' || resolved === '') return false
  let url: URL
  try {
    url = new URL(resolved.includes('://') ? resolved : `https://${resolved}`)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === '' || host === 'localhost') return false
  if (host.includes(':')) {
    return !(
      host === '::1' ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe80')
    )
  }
  if (isPrivateIpv4(host)) return false
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false
  return host.includes('.')
}

/** Whether the hub has a genuinely public endpoint (the address itself is not kept). */
export async function readPublicEndpoint(client: HubClient): Promise<Read<boolean>> {
  const read = await readQuery(client, 'localNetwork.getAddresses', {}, AddressesSchema)
  if (!read.ok) return read
  return {
    ok: true,
    value: isPublicEndpoint(read.value.roles?.publicEndpoint?.resolved),
  }
}

const AccessStatusSchema = z
  .looseObject({
    connected: z.boolean().optional(),
    endpoint: z.looseObject({ stable: z.boolean().optional() }).nullish(),
  })
  .nullable()

/**
 * Whether the hub can be reached from outside: a genuinely public endpoint, or
 * a remote access that reports connected. A failed read is not reachable (the
 * caller keeps the read's reason for its own verdict). Shared by the
 * remote-access step and the core-addons remote group.
 */
export function remoteReachable(endpoint: Read<boolean>, access: Read<RemoteAccessFact>): boolean {
  return (endpoint.ok && endpoint.value) || (access.ok && access.value.connected)
}

export interface RemoteAccessFact {
  readonly connected: boolean
  readonly hasEndpoint: boolean
}

export async function readRemoteAccessStatus(client: HubClient): Promise<Read<RemoteAccessFact>> {
  const read = await readQuery(client, 'networkAccess.getStatus', {}, AccessStatusSchema)
  if (!read.ok) return read
  return {
    ok: true,
    value: {
      connected: read.value?.connected === true,
      hasEndpoint: read.value?.endpoint != null,
    },
  }
}

const DestinationListSchema = z.array(
  z.looseObject({
    enabled: z.boolean(),
    cron: z.string().optional(),
    lastSuccessAt: z.number().optional(),
  }),
)

export interface BackupFact {
  readonly enabled: boolean
  readonly scheduled: boolean
  readonly lastSuccessAt: number | null
}

export async function readBackupDestinations(
  client: HubClient,
): Promise<Read<readonly BackupFact[]>> {
  const read = await readQuery(client, 'backup.listDestinations', undefined, DestinationListSchema)
  if (!read.ok) return read
  return {
    ok: true,
    value: read.value.map((d) => ({
      enabled: d.enabled,
      scheduled: d.cron !== undefined && d.cron !== '',
      lastSuccessAt: d.lastSuccessAt ?? null,
    })),
  }
}

const RuleListSchema = z.looseObject({
  rules: z.array(
    z.looseObject({
      enabled: z.boolean().optional(),
      delivery: z.string(),
      conditions: z.looseObject({ devices: z.array(z.number()).optional() }).optional(),
    }),
  ),
})

export interface RuleFact {
  readonly enabled: boolean
  readonly delivery: string
  readonly conditions: { readonly [conditionId: string]: unknown }
  /** Device scope; `null` = every device. */
  readonly devices: readonly number[] | null
}

export async function readRules(client: HubClient): Promise<Read<readonly RuleFact[]>> {
  const read = await readQuery(client, 'notificationRules.listRules', {}, RuleListSchema)
  if (!read.ok) return read
  return {
    ok: true,
    value: read.value.rules.map((r) => {
      const devices = r.conditions?.devices
      return {
        enabled: r.enabled !== false,
        delivery: r.delivery,
        conditions: r.conditions ?? {},
        devices: devices !== undefined && devices.length > 0 ? devices : null,
      }
    }),
  }
}

export interface CameraSetupFact {
  readonly id: number
  readonly name: string
  /** `null`: the recording config could not be read — unknown, never "off". */
  readonly recordingMode: RecordingStorageMode | null
  /** Profiles the camera has streams for but no source assigned (`high` = main, `low` = sub). */
  readonly unassigned: readonly CamProfile[]
}

/**
 * Per enabled camera: does it record, and does it have its main (and sub)
 * stream assigned. The same reads `setup_recording` and `setup_streams` make
 * (`recordingArchive.getDeviceConfig`, the camera streams and profile slots),
 * reduced to what the cameras step judges. A bulk read that failed is the
 * whole answer's failure; one camera's config that failed is that camera's
 * `null`.
 */
export async function readCameraSetup(
  client: HubClient,
): Promise<Read<readonly CameraSetupFact[]>> {
  const [rows, streams, slots] = await Promise.all([
    readCameraRows(client),
    readQuery(client, 'streamBroker.listAllCameraStreams', undefined, z.array(CameraStreamSchema)),
    readQuery(client, 'streamBroker.listAllProfileSlots', undefined, z.array(ProfileSlotSchema)),
  ])
  if (!rows.ok) return rows
  if (!streams.ok) return streams
  if (!slots.ok) return slots
  const facts = await mapLimit(
    rows.value.filter((c) => !c.disabled),
    READ_CONCURRENCY,
    async (cam): Promise<CameraSetupFact> => {
      const config = await readQuery(
        client,
        'recordingArchive.getDeviceConfig',
        { deviceId: cam.id },
        RecordingConfigSchema,
      )
      const native = streams.value.filter((s) => s.deviceId === cam.id && s.kind !== 'derived')
      return {
        id: cam.id,
        name: cam.name,
        recordingMode: config.ok ? deriveRecordingMode(config.value) : null,
        unassigned: unassignedProfiles(
          native.length,
          slots.value.filter((s) => s.deviceId === cam.id),
        ),
      }
    },
  )
  return { ok: true, value: facts }
}
