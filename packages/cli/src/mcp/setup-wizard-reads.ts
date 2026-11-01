/**
 * The hub reads behind `setup_wizard`. Every schema is loose (a newer hub may
 * add fields) and every wrapper strips what the wizard does not need: a user
 * is reduced to id / isAdmin / totpEnabled, a target to id / name / kind, a
 * backup destination to its enabled flag, cadence and last success. Nothing
 * here can carry a credential into an answer.
 */
import type { HubClient } from '@camstack/develop'
import { z } from 'zod'
import { readQuery, type Read } from './ops-hub.js'

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

/** Whether the hub has a resolved public endpoint (the address itself is not kept). */
export async function readPublicEndpoint(client: HubClient): Promise<Read<boolean>> {
  const read = await readQuery(client, 'localNetwork.getAddresses', {}, AddressesSchema)
  if (!read.ok) return read
  const resolved = read.value.roles?.publicEndpoint?.resolved
  return { ok: true, value: resolved !== undefined && resolved !== null && resolved !== '' }
}

const AccessStatusSchema = z
  .looseObject({
    connected: z.boolean().optional(),
    endpoint: z.looseObject({ stable: z.boolean().optional() }).nullish(),
  })
  .nullable()

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
